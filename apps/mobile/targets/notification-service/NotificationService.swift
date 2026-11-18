import Foundation
import Intents
import Security
import UserNotifications

/// Opens each alert with this iPhone's key for the Mac that sealed it. Whatever it cannot open keeps the outer text. A
/// text from an Orcling's chat comes as a message from the Orcling, its face beside it as a person's photo is.
final class NotificationService: UNNotificationServiceExtension {
  private var pending: (handler: (UNNotificationContent) -> Void, content: UNNotificationContent)?
  /// The donation's completion and the time running out can come on different threads; the handler runs once.
  private let lock = NSLock()

  override func didReceive(_ request: UNNotificationRequest, withContentHandler contentHandler: @escaping (UNNotificationContent) -> Void) {
    guard let content = request.content.mutableCopy() as? UNMutableNotificationContent else { return contentHandler(request.content) }
    let revealed = reveal(content, keys: DeviceKey.read)
    guard #available(iOS 15.0, macOS 12.0, *), let revealed, let face = revealed.face, let intent = message(from: revealed.notice, face: face) else { return contentHandler(content) }
    // Revealing is a few milliseconds; only the donation can run long, and the revealed text is delivered if it does.
    lock.lock()
    pending = (contentHandler, content)
    lock.unlock()
    let interaction = INInteraction(intent: intent, response: nil)
    interaction.direction = .incoming
    interaction.donate { [weak self] _ in
      self?.deliver((try? content.updating(from: intent)) ?? content)
    }
  }

  override func serviceExtensionTimeWillExpire() {
    deliver(nil)
  }

  /// Hands iOS the message, or with nil the revealed text, once.
  private func deliver(_ content: UNNotificationContent?) {
    lock.lock()
    let waiting = pending
    pending = nil
    lock.unlock()
    if let waiting { waiting.handler(content ?? waiting.content) }
  }
}

/// The Orcling's text as iOS shows a message: its name and face as the sender, in a conversation per chat.
@available(iOS 15.0, macOS 12.0, *)
func message(from notice: PushNotice, face look: OrclingLook) -> INSendMessageIntent? {
  guard let threadId = notice.threadId, let face = OrclingFace.png(look) else { return nil }
  let image = INImage(imageData: face)
  let sender = INPerson(personHandle: INPersonHandle(value: threadId, type: .unknown), nameComponents: nil, displayName: notice.title, image: image, contactIdentifier: nil, customIdentifier: threadId)
  let intent = INSendMessageIntent(recipients: nil, outgoingMessageType: .outgoingMessageText, content: notice.body, speakableGroupName: nil, conversationIdentifier: threadId, serviceName: nil, sender: sender, attachments: nil)
  #if os(iOS)
    intent.setImage(image, forParameterNamed: \.sender)
  #endif
  return intent
}

/// What reveal opened: the notice, and the Orcling's look when one was sealed beside it.
struct Revealed {
  let notice: PushNotice
  let face: OrclingLook?
}

/// The alert's text, thread and actions from the sealed notice, and in place of everything else only the ids the app
/// needs to route a tap, with the sealed notice they came from. expo-notifications hands a remote alert's
/// `userInfo["body"]` to the app as its data. Nil when nothing opened.
@discardableResult
func reveal(_ content: UNMutableNotificationContent, keys: (String) -> DeviceKey) -> Revealed? {
  // Anyone able to push to this phone can name a category and write a route; only the Mac can seal one. So whatever
  // this does not open offers no actions and routes no tap, whatever the push asked for.
  let raw = content.userInfo["o"]
  let rawFace = content.userInfo["f"]
  content.categoryIdentifier = ""
  content.threadIdentifier = ""
  content.userInfo = [:]
  guard let envelope = decoded(raw) else { return nil }
  guard envelope.v == PushOpener.version else {
    content.body = "Update OpenOrc on this iPhone to read this."
    return nil
  }
  let key: Data
  switch keys(envelope.m) {
  case .found(let found): key = found
  case .missing:
    content.body = "From a Mac this iPhone no longer pairs with."
    return nil
  case .locked: return nil
  }
  guard let notice = try? PushOpener.open(envelope, phonePrivateKey: key) else { return nil }
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
  // Sealed by the same Mac for this phone, or it does not open: a face from anywhere else never shows.
  let face = decoded(rawFace).flatMap { $0.m == envelope.m ? try? PushOpener.openFace($0, phonePrivateKey: key) : nil }
  return Revealed(notice: notice, face: face)
}

private func decoded(_ raw: Any?) -> PushEnvelope? {
  guard let raw, JSONSerialization.isValidJSONObject(raw), let json = try? JSONSerialization.data(withJSONObject: raw) else { return nil }
  return try? JSONDecoder().decode(PushEnvelope.self, from: json)
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
