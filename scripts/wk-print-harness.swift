// Minimal WKWebView probe. No print panel and no clicks.
//
//   swift scripts/wk-print-harness.swift
//
// GitHub's macOS runner never returned from NSPrintOperation.run() (the process hit its own
// 20s watchdog). The default path is therefore WKWebView.createPDF, which does not open a panel
// and does not promise beforeprint/afterprint. Set MDPAD_WK_MODAL=1 to try the modal operation
// on a machine with a window server; that call is what wry uses (printOperationWithPrintInfo).
// One JSON line on stdout. This records what happened. It does not claim pagination is fixed.
import AppKit
import WebKit
import PDFKit

func log(_ message: String) {
    fputs(message + "\n", stderr)
    fflush(stderr)
}

final class LoadWait: NSObject, WKNavigationDelegate {
    var failed: String?
    var finished = false
    func webView(_ webView: WKWebView, didFinish navigation: WKNavigation!) { finished = true }
    func webView(_ webView: WKWebView, didFail navigation: WKNavigation!, withError error: Error) {
        failed = error.localizedDescription
        finished = true
    }
    func webView(_ webView: WKWebView, didFailProvisionalNavigation navigation: WKNavigation!, withError error: Error) {
        failed = error.localizedDescription
        finished = true
    }
}

func pump(until done: () -> Bool, seconds: TimeInterval) -> Bool {
    let deadline = Date().addingTimeInterval(seconds)
    while !done() && Date() < deadline {
        RunLoop.current.run(mode: .default, before: Date().addingTimeInterval(0.05))
    }
    return done()
}

let rows = (1...40).map { i -> String in
    "<tr><td>R\(String(format: "%02d", i))</td><td>cell \(i)</td></tr>"
}.joined()
let html = """
<!doctype html>
<html><head><meta charset="utf-8"><style>
  #print-root { position: absolute; left: 0; top: 0; width: 180mm; visibility: hidden; }
  @media print {
    body > *:not(#print-root) { display: none !important; }
    #print-root { visibility: visible !important; position: static !important; }
    table, tr, td { break-inside: auto !important; }
  }
</style></head>
<body>
<div id="editor">EDITOR-VISIBLE</div>
<div id="print-root"><p>MARK-START</p><table>\(rows)</table><p>MARK-END</p></div>
<script>
window.__events = [];
addEventListener('beforeprint', () => window.__events.push('beforeprint'));
addEventListener('afterprint', () => window.__events.push('afterprint'));
</script>
</body></html>
"""

let app = NSApplication.shared
app.setActivationPolicy(.accessory)
DispatchQueue.global().asyncAfter(deadline: .now() + 25) {
    log("wk-print: timed out")
    exit(2)
}

let web = WKWebView(frame: NSRect(x: 0, y: 0, width: 800, height: 4000))
let window = NSWindow(contentRect: NSRect(x: 0, y: 0, width: 800, height: 600), styleMask: [.titled], backing: .buffered, defer: false)
window.contentView = web
let wait = LoadWait()
web.navigationDelegate = wait
log("wk-print: loading")
web.loadHTMLString(html, baseURL: nil)
if !pump(until: { wait.finished }, seconds: 8) || wait.failed != nil {
    log("wk-print: page did not load \(wait.failed ?? "timeout")")
    exit(3)
}
log("wk-print: loaded")

final class Slot {
    var pdf = Data()
    var events = "[]"
    var done = false
}
let slot = Slot()
let modal = ProcessInfo.processInfo.environment["MDPAD_WK_MODAL"] == "1"
let api = modal ? "printOperation" : "createPDF"
if modal {
    let pdfURL = URL(fileURLWithPath: NSTemporaryDirectory()).appendingPathComponent("mdpad-wk-print.pdf")
    try? FileManager.default.removeItem(at: pdfURL)
    let info = NSPrintInfo.shared.copy() as! NSPrintInfo
    info.jobDisposition = .save
    info.dictionary()[NSPrintInfo.AttributeKey.jobSavingURL] = pdfURL
    let operation = web.printOperation(with: info)
    operation.showsPrintPanel = false
    operation.showsProgressPanel = false
    log("wk-print: modal run")
    _ = operation.run()
    slot.pdf = (try? Data(contentsOf: pdfURL)) ?? Data()
    log("wk-print: modal returned \(slot.pdf.count) bytes")
} else {
    log("wk-print: createPDF")
    web.createPDF(configuration: WKPDFConfiguration()) { result in
        if case .success(let data) = result { slot.pdf = data }
        slot.done = true
    }
    _ = pump(until: { slot.done }, seconds: 15)
    slot.done = false
    log("wk-print: createPDF \(slot.pdf.count) bytes")
}

web.evaluateJavaScript("JSON.stringify(window.__events || [])") { value, _ in
    if let value = value as? String { slot.events = value }
    slot.done = true
}
_ = pump(until: { slot.done }, seconds: 3)
let pdf = slot.pdf
let events = slot.events

let document = PDFDocument(data: pdf)
let text = document?.string ?? ""
let payload: [String: Any] = [
    "api": api,
    "events": events,
    "pages": document?.pageCount ?? 0,
    "hasStart": text.contains("MARK-START"),
    "hasEnd": text.contains("MARK-END"),
    "hasRow": text.contains("R40"),
    "bytes": pdf.count,
]
let data = try JSONSerialization.data(withJSONObject: payload)
FileHandle.standardOutput.write(data)
FileHandle.standardOutput.write(Data("\n".utf8))
// The JSON is the observation. A PDF that lacks the end marker is still a result.
exit(0)
