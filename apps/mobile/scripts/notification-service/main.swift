import CoreGraphics
import Foundation
import ImageIO
import UserNotifications

// Runs the extension's own reveal over the cases notification-service.test.mts sends on stdin, each an alert as APNs
// delivers it and what the Keychain holds for its Mac, and prints what iOS would show.

struct Case: Decodable {
  let name: String
  let userInfo: String
  /// "found", "missing" or "locked".
  let key: String
  /// Where to write the Orcling's face, when one opens beside the notice.
  let facePath: String?
}

/// The drawn face's color at a point of its 100-unit square, as "#rrggbbaa", read back from the PNG.
func colorAt(_ png: Data, x: CGFloat, y: CGFloat) -> String {
  guard let source = CGImageSourceCreateWithData(png as CFData, nil), let image = CGImageSourceCreateImageAtIndex(source, 0, nil) else { return "" }
  var pixel = [UInt8](repeating: 0, count: 4)
  let context = CGContext(data: &pixel, width: 1, height: 1, bitsPerComponent: 8, bytesPerRow: 4, space: CGColorSpace(name: CGColorSpace.sRGB)!, bitmapInfo: CGImageAlphaInfo.premultipliedLast.rawValue)!
  let side = CGFloat(image.width)
  // One pixel of the image lands on the context's only pixel; the image's y runs up in CoreGraphics.
  context.draw(image, in: CGRect(x: -x / 100 * side, y: -(side - y / 100 * side), width: side, height: side))
  return "#" + pixel.map { String(format: "%02x", $0) }.joined()
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
  let revealed = reveal(content) { macId in
    asked.append(macId)
    switch item.key {
    case "found": return .found(phoneKey)
    case "missing": return .missing
    default: return .locked
    }
  }
  var entry: [String: Any] = [
    "name": item.name,
    "title": content.title,
    "subtitle": content.subtitle,
    "body": content.body,
    "threadIdentifier": content.threadIdentifier,
    "categoryIdentifier": content.categoryIdentifier,
    "userInfo": content.userInfo,
    "asked": asked,
  ]
  if let look = revealed?.face {
    var face: [String: Any] = ["bodyColor": look.bodyColor]
    if let png = OrclingFace.png(look) {
      if let path = item.facePath { try png.write(to: URL(fileURLWithPath: path)) }
      face["center"] = colorAt(png, x: 50, y: 62)
      face["corner"] = colorAt(png, x: 1, y: 1)
    }
    entry["face"] = face
  }
  return entry
}
FileHandle.standardOutput.write(try JSONSerialization.data(withJSONObject: shown))
