// Minimal WKWebView print probe. Run on a Mac with Xcode's Swift:
//   swift scripts/wk-print-harness.swift
// It does not click the print panel. showsPrintPanel is false and the job is saved to a PDF.
// Prints one JSON line: whether beforeprint/afterprint fired, and whether the PDF still has
// the start and end markers. This is evidence, not a claim that pagination is fixed.
import AppKit
import WebKit
import PDFKit

final class LoadWait: NSObject, WKNavigationDelegate {
    var failed: String?
    var finished = false
    func webView(_ webView: WKWebView, didFinish navigation: WKNavigation!) {
        finished = true
    }
    func webView(_ webView: WKWebView, didFail navigation: WKNavigation!, withError error: Error) {
        failed = error.localizedDescription
        finished = true
    }
    func webView(_ webView: WKWebView, didFailProvisionalNavigation navigation: WKNavigation!, withError error: Error) {
        failed = error.localizedDescription
        finished = true
    }
}

let rows = (1...40).map { i -> String in
    let n = String(format: "%02d", i)
    return "<tr><td>R\(n)</td><td>cell \(i)</td></tr>"
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
<div id="print-root">
<p>MARK-START</p>
<table>\(rows)</table>
<p>MARK-END</p>
</div>
<script>
window.__events = [];
addEventListener('beforeprint', () => window.__events.push('beforeprint'));
addEventListener('afterprint', () => window.__events.push('afterprint'));
</script>
</body></html>
"""

let app = NSApplication.shared
app.setActivationPolicy(.accessory)
DispatchQueue.global().asyncAfter(deadline: .now() + 20) {
    fputs("wk-print: timed out before the print operation returned\n", stderr)
    exit(2)
}

let web = WKWebView(frame: NSRect(x: 0, y: 0, width: 800, height: 1000))
let window = NSWindow(contentRect: web.frame, styleMask: [.titled], backing: .buffered, defer: false)
window.contentView = web
let wait = LoadWait()
web.navigationDelegate = wait
web.loadHTMLString(html, baseURL: nil)
let deadline = Date().addingTimeInterval(8)
while !wait.finished && Date() < deadline {
    RunLoop.current.run(mode: .default, before: Date().addingTimeInterval(0.05))
}
if wait.failed != nil || !wait.finished {
    fputs("wk-print: page did not load \(wait.failed ?? "timeout")\n", stderr)
    exit(3)
}

let pdfURL = URL(fileURLWithPath: NSTemporaryDirectory()).appendingPathComponent("mdpad-wk-print.pdf")
try? FileManager.default.removeItem(at: pdfURL)
let info = NSPrintInfo.shared.copy() as! NSPrintInfo
info.jobDisposition = .save
info.dictionary()[NSPrintInfo.AttributeKey.jobSavingURL] = pdfURL
let operation = web.printOperation(with: info)
operation.showsPrintPanel = false
operation.showsProgressPanel = false
operation.run()

final class ScriptWait: NSObject {
    var text: String?
    var done = false
}
let scriptWait = ScriptWait()
web.evaluateJavaScript("JSON.stringify(window.__events || [])") { value, _ in
    scriptWait.text = value as? String
    scriptWait.done = true
}
let scriptDeadline = Date().addingTimeInterval(3)
while !scriptWait.done && Date() < scriptDeadline {
    RunLoop.current.run(mode: .default, before: Date().addingTimeInterval(0.05))
}

let document = PDFDocument(url: pdfURL)
let text = document?.string ?? ""
let pages = document?.pageCount ?? 0
let payload: [String: Any] = [
    "events": scriptWait.text ?? "[]",
    "pages": pages,
    "hasStart": text.contains("MARK-START"),
    "hasEnd": text.contains("MARK-END"),
    "hasRow": text.contains("R40"),
    "bytes": (try? Data(contentsOf: pdfURL).count) ?? 0,
]
let data = try JSONSerialization.data(withJSONObject: payload)
FileHandle.standardOutput.write(data)
FileHandle.standardOutput.write(Data("\n".utf8))
if payload["hasStart"] as? Bool == true && payload["hasEnd"] as? Bool == true {
    exit(0)
}
exit(1)
