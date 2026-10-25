import Foundation
import UserNotifications

// Runs the extension's own reveal over the cases notification-service.test.mts sends on stdin, each an alert as APNs
// delivers it and what the Keychain holds for its Mac, and prints what iOS would show.

struct Case: Decodable {
  let name: String
  let userInfo: String
  /// "found", "missing" or "locked".
  let key: String
}

struct Input: Decodable {
  let phoneKey: String
  let cases: [Case]
}

let input = try JSONDecoder().decode(Input.self, from: FileHandle.standardInput.readDataToEndOfFile())
guard let phoneKey = Data(base64URL: input.phoneKey) else { fatalError("The phone key is not base64url.") }

let shown: [[String: Any]] = try input.cases.map { item in
  let content = UNMutableNotificationContent()
  let userInfo = try JSONSerialization.jsonObject(with: Data(item.userInfo.utf8)) as? [AnyHashable: Any] ?? [:]
  // As iOS fills it before the extension runs: the push's own text, category and thread.
  let aps = userInfo["aps"] as? [String: Any] ?? [:]
  let alert = aps["alert"] as? [String: Any] ?? [:]
  content.title = alert["title"] as? String ?? ""
  content.subtitle = alert["subtitle"] as? String ?? ""
  content.body = alert["body"] as? String ?? ""
  content.categoryIdentifier = aps["category"] as? String ?? ""
  content.threadIdentifier = aps["thread-id"] as? String ?? ""
  content.userInfo = userInfo
  var asked: [String] = []
  reveal(content) { macId in
    asked.append(macId)
    switch item.key {
    case "found": return .found(phoneKey)
    case "missing": return .missing
    default: return .locked
    }
  }
  return [
    "name": item.name,
    "title": content.title,
    "subtitle": content.subtitle,
    "body": content.body,
    "threadIdentifier": content.threadIdentifier,
    "categoryIdentifier": content.categoryIdentifier,
    "userInfo": content.userInfo,
    "asked": asked,
  ]
}
FileHandle.standardOutput.write(try JSONSerialization.data(withJSONObject: shown))
