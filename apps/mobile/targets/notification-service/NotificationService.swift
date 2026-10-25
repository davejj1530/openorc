import Foundation
import Security
import UserNotifications

/// Opens each alert with this iPhone's key for the Mac that sealed it. Whatever it cannot open keeps the outer text.
final class NotificationService: UNNotificationServiceExtension {
  override func didReceive(_ request: UNNotificationRequest, withContentHandler contentHandler: @escaping (UNNotificationContent) -> Void) {
    guard let content = request.content.mutableCopy() as? UNMutableNotificationContent else { return contentHandler(request.content) }
    // Synchronous and a few milliseconds: there is nothing for serviceExtensionTimeWillExpire to cut short.
    reveal(content, keys: DeviceKey.read)
    contentHandler(content)
  }
}

/// The alert's text, thread and actions from the sealed notice, and in place of everything else only the ids the app
/// needs to route a tap, with the sealed notice they came from. expo-notifications hands a remote alert's
/// `userInfo["body"]` to the app as its data.
func reveal(_ content: UNMutableNotificationContent, keys: (String) -> DeviceKey) {
  // Anyone able to push to this phone can name a category and write a route; only the Mac can seal one. So whatever
  // this does not open offers no actions and routes no tap, whatever the push asked for.
  let raw = content.userInfo["o"]
  content.categoryIdentifier = ""
  content.threadIdentifier = ""
  content.userInfo = [:]
  guard let raw, JSONSerialization.isValidJSONObject(raw), let json = try? JSONSerialization.data(withJSONObject: raw),
    let envelope = try? JSONDecoder().decode(PushEnvelope.self, from: json)
  else { return }
  guard envelope.v == PushOpener.version else {
    content.body = "Update OpenOrc on this iPhone to read this."
    return
  }
  let key: Data
  switch keys(envelope.m) {
  case .found(let found): key = found
  case .missing:
    content.body = "From a Mac this iPhone no longer pairs with."
    return
  case .locked: return
  }
  guard let notice = try? PushOpener.open(envelope, phonePrivateKey: key) else { return }
  // The text iOS shows is the Mac's alone: a subtitle pushed beside a recorded notice would sit above its actions.
  content.title = notice.title
  content.subtitle = ""
  content.body = notice.body
  var route: [String: Any] = ["macId": envelope.m, "id": notice.id, "kind": notice.kind, "o": ["v": envelope.v, "m": envelope.m, "n": envelope.n, "c": envelope.c]]
  if let threadId = notice.threadId {
    content.threadIdentifier = threadId
    route["threadId"] = threadId
  }
  if let approval = notice.approval {
    route["runId"] = approval.runId
    route["approvalId"] = approval.approvalId
    if notice.kind == "approval" { content.categoryIdentifier = "approval" }
  }
  content.userInfo = ["body": route]
}

/// This iPhone's key for one Mac, as expo-secure-store wrote it: a generic password under service "app:no-auth", the
/// account the key name's UTF-8 bytes, the value base64url text.
enum DeviceKey {
  case found(Data)
  case missing
  /// Before the first unlock after a restart, the Keychain does not answer.
  case locked

  static func read(macId: String) -> DeviceKey {
    // No access group: the query searches every group the extension has, and its one group is the app's.
    let query: [CFString: Any] = [
      kSecClass: kSecClassGenericPassword,
      kSecAttrService: "app:no-auth",
      kSecAttrAccount: Data("device-key.\(macId)".utf8),
      kSecReturnData: true,
      kSecMatchLimit: kSecMatchLimitOne,
    ]
    var item: CFTypeRef?
    switch SecItemCopyMatching(query as CFDictionary, &item) {
    case errSecSuccess:
      guard let data = item as? Data, let key = Data(base64URL: String(decoding: data, as: UTF8.self)) else { return .missing }
      return .found(key)
    case errSecItemNotFound: return .missing
    default: return .locked
    }
  }
}
