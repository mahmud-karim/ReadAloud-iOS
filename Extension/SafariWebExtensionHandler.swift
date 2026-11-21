import SafariServices
import os.log

/// Safari requires a native handler for every web extension. Read Aloud does all its work in
/// JavaScript, so this only answers pings from the extension.
final class SafariWebExtensionHandler: NSObject, NSExtensionRequestHandling {
    func beginRequest(with context: NSExtensionContext) {
        let request = context.inputItems.first as? NSExtensionItem
        let message: Any?
        if #available(iOS 17.0, *) {
            message = request?.userInfo?[SFExtensionMessageKey]
        } else {
            message = request?.userInfo?["message"]
        }
        os_log(.default, "Read Aloud got a native message: %@", String(describing: message))

        let response = NSExtensionItem()
        if #available(iOS 17.0, *) {
            response.userInfo = [SFExtensionMessageKey: ["ok": true]]
        } else {
            response.userInfo = ["message": ["ok": true]]
        }
        context.completeRequest(returningItems: [response], completionHandler: nil)
    }
}
