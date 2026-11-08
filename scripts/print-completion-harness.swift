// Proves AppKit calls printOperationDidRun:success:contextInfo: .
// This is the completion callback for the system print panel. It is not a product PDF test:
// the panel is hidden and the job is saved to a file so CI does not need a click.
// A timeout exits 2 and fails the step. createPDF is a different probe and is not this one.
//
//   swift scripts/print-completion-harness.swift
import AppKit
import WebKit

final class LoadWait: NSObject, WKNavigationDelegate {
    var finished = false
    func webView(_ webView: WKWebView, didFinish navigation: WKNavigation!) { finished = true }
    func webView(_ webView: WKWebView, didFail navigation: WKNavigation!, withError error: Error) { finished = true }
    func webView(_ webView: WKWebView, didFailProvisionalNavigation navigation: WKNavigation!, withError error: Error) { finished = true }
}

final class PrintDelegate: NSObject {
    var called = false
    var success = false
    @objc func printOperationDidRun(_ operation: NSPrintOperation, success: Bool, contextInfo: UnsafeMutableRawPointer?) {
        called = true
        self.success = success
        fputs("print-completion: didRun success=\(success)\n", stderr)
        fflush(stderr)
    }
}

func pump(until done: () -> Bool, seconds: TimeInterval) -> Bool {
    let deadline = Date().addingTimeInterval(seconds)
    while !done() && Date() < deadline {
        RunLoop.current.run(mode: .default, before: Date().addingTimeInterval(0.05))
    }
    return done()
}

fputs("print-completion: NSPrintOperation didRun harness, not a product PDF test\n", stderr)
fflush(stderr)

let app = NSApplication.shared
app.setActivationPolicy(.accessory)
DispatchQueue.global().asyncAfter(deadline: .now() + 20) {
    fputs("print-completion: timed out before didRun\n", stderr)
    fflush(stderr)
    exit(2)
}

let html = "<html><body><p>MARK-START</p><p>MARK-END-7fac</p></body></html>"
let web = WKWebView(frame: NSRect(x: 0, y: 0, width: 800, height: 1000))
let window = NSWindow(contentRect: web.frame, styleMask: [.titled], backing: .buffered, defer: false)
window.contentView = web
let wait = LoadWait()
web.navigationDelegate = wait
web.loadHTMLString(html, baseURL: nil)
if !pump(until: { wait.finished }, seconds: 8) {
    fputs("print-completion: page did not load\n", stderr)
    fflush(stderr)
    exit(3)
}
fputs("print-completion: page loaded\n", stderr)
fflush(stderr)

let pdfURL = URL(fileURLWithPath: NSTemporaryDirectory()).appendingPathComponent("mdpad-print-completion.pdf")
try? FileManager.default.removeItem(at: pdfURL)
let info = NSPrintInfo.shared.copy() as! NSPrintInfo
info.jobDisposition = .save
info.dictionary()[NSPrintInfo.AttributeKey.jobSavingURL] = pdfURL
let operation = web.printOperation(with: info)
operation.showsPrintPanel = false
operation.showsProgressPanel = false
operation.canSpawnSeparateThread = false
let delegate = PrintDelegate()
let selector = #selector(PrintDelegate.printOperationDidRun(_:success:contextInfo:))
// The print panel's run loop is not the default mode, so a normal dispatch timer never fires.
// Schedule the dismiss on the modal mode. No click, no GUI automation.
let dismiss = Timer(timeInterval: 1, repeats: false) { _ in
    fputs("print-completion: dismissing the modal without a click\n", stderr)
    fflush(stderr)
    NSApp.stopModal()
}
RunLoop.current.add(dismiss, forMode: .common)
RunLoop.current.add(dismiss, forMode: .modalPanel)
fputs("print-completion: runModal\n", stderr)
fflush(stderr)
operation.runModal(for: window, delegate: delegate, didRun: selector, contextInfo: nil)
fputs("print-completion: runModal returned called=\(delegate.called)\n", stderr)
fflush(stderr)
let fired = delegate.called || pump(until: { delegate.called }, seconds: 5)
let payload: [String: Any] = [
    "api": "printOperationDidRun",
    "callback": delegate.called,
    "success": delegate.success,
    "productTest": false,
]
let data = try JSONSerialization.data(withJSONObject: payload)
FileHandle.standardOutput.write(data)
FileHandle.standardOutput.write(Data("\n".utf8))
exit(fired ? 0 : 1)
