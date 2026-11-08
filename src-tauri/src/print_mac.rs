//! macOS print panel with a real completion callback.
//!
//! wry 0.57's `WebView::print` calls `runOperationModalForWindow:delegate:didRunSelector:`
//! with a nil delegate, and it sets `canSpawnSeparateThread`, so that call returns before the
//! panel is finished. The `WKUIDelegate` in that build has no print method, so `window.print()`
//! in the page does not open a panel.
//!
//! AppKit's `runOperationModalForWindow:delegate:didRunSelector:contextInfo:` returns
//! immediately and later sends `printOperationDidRun:success:contextInfo:`. `success` is false
//! when the user cancels or closes the panel. `canSpawnSeparateThread` stays false, so page
//! generation is done before that callback and the on-screen print tree is still in place.

use std::cell::RefCell;
use std::ffi::c_void;
use std::sync::{Arc, Mutex};

use objc2::rc::Retained;
use objc2::runtime::{AnyObject, Bool};
use objc2::{define_class, msg_send, sel, DefinedClass, MainThreadOnly};
use objc2_app_kit::{NSPrintInfo, NSPrintOperation, NSWindow};
use objc2_foundation::{NSObject, NSObjectProtocol};
use objc2_web_kit::WKWebView;
use tauri::{AppHandle, Emitter, WebviewWindow};

use crate::print_session;

struct PrintDelegateIvars {
    app: AppHandle,
    label: String,
}

define_class!(
    #[unsafe(super(NSObject))]
    #[thread_kind = MainThreadOnly]
    #[ivars = PrintDelegateIvars]
    struct PrintDelegate;

    impl PrintDelegate {
        #[unsafe(method(printOperationDidRun:success:contextInfo:))]
        fn print_operation_did_run(&self, _operation: &AnyObject, success: Bool, _context: *mut c_void) {
            let label = self.ivars().label.clone();
            let app = self.ivars().app.clone();
            // This window only. Another window's panel is a different label.
            print_session::end(&label);
            let _ = app.emit_to(&label, "print-finished", serde_json::json!({ "success": success.as_bool() }));
        }
    }

    unsafe impl NSObjectProtocol for PrintDelegate {}
);

impl PrintDelegate {
    fn new(mtm: objc2::MainThreadMarker, app: AppHandle, label: String) -> Retained<Self> {
        let this = mtm.alloc::<Self>().set_ivars(PrintDelegateIvars { app, label });
        unsafe { msg_send![super(this), init] }
    }
}

thread_local! {
    // AppKit does not retain the delegate. The callback runs on this thread, so the
    // object has to stay alive here until the process exits. Dropping it inside the
    // callback would free `self` while the call is still on the stack.
    static HELD: RefCell<Vec<Retained<PrintDelegate>>> = RefCell::new(Vec::new());
}

pub fn print_page(window: WebviewWindow) -> Result<(), String> {
    let label = window.label().to_string();
    if !print_session::begin(&label) {
        return Err("这个窗口正在打印".into());
    }
    let app = window.app_handle().clone();
    let started = Arc::new(Mutex::new(None));
    let slot = started.clone();
    let run = window.with_webview(move |webview| {
        *slot.lock().unwrap() = Some(start(&webview, app, label));
    });
    if let Err(err) = run {
        print_session::end(&window.label());
        return Err(err.to_string());
    }
    match started.lock().unwrap().take() {
        Some(Ok(())) => Ok(()),
        Some(Err(err)) => {
            print_session::end(&window.label());
            Err(err)
        }
        None => {
            print_session::end(&window.label());
            Err("打印没有开始".into())
        }
    }
}

fn start(webview: &tauri::webview::PlatformWebview, app: AppHandle, label: String) -> Result<(), String> {
    let Some(mtm) = objc2::MainThreadMarker::new() else {
        return Err("打印只能在主线程开始".into());
    };
    let view = unsafe { &*(webview.inner() as *mut WKWebView) };
    let ns_window = unsafe { &*(webview.ns_window() as *mut NSWindow) };
    let responds: Bool = unsafe { msg_send![view, respondsToSelector: sel!(printOperationWithPrintInfo:)] };
    if !responds.as_bool() {
        return Err("这个系统版本不能打印".into());
    }
    let operation: Retained<NSPrintOperation> = unsafe { view.printOperationWithPrintInfo(&NSPrintInfo::sharedPrintInfo()) };
    // Leave page generation on this thread so the callback is not early.
    operation.setCanSpawnSeparateThread(false);
    let delegate = PrintDelegate::new(mtm, app, label);
    let delegate_ref = unsafe { &*Retained::as_ptr(&delegate).cast::<AnyObject>() };
    HELD.with(|held| held.borrow_mut().push(delegate));
    unsafe {
        operation.runOperationModalForWindow_delegate_didRunSelector_contextInfo(
            ns_window,
            Some(delegate_ref),
            Some(sel!(printOperationDidRun:success:contextInfo:)),
            std::ptr::null_mut(),
        );
    }
    Ok(())
}
