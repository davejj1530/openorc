import CryptoKit
import Foundation

// Opens what packages/link/src/push.ts seals. Foundation and CryptoKit only, so the macOS vector check
// (apps/mobile/scripts/push-vectors) compiles this same file.

struct PushEnvelope: Decodable { let v: Int; let m: String; let n: String; let c: String }

struct PushNotice: Decodable {
  struct Approval: Decodable { let runId: String; let approvalId: String }
  let id: String
  let kind: String
  let threadId: String?
  let title: String
  let body: String
  let approval: Approval?
}

/// How an Orcling looks, as the Mac seals it beside an alert from its chat: the app's look numbers and colors.
struct OrclingLook: Decodable, Equatable {
  let shape: Int
  let eyes: Int
  let texture: Int
  let glasses: Int
  let accessory: Int
  let bodyColor: String
  let eyeColor: String
}

enum PushFailure: Error { case unknownVersion, malformed }

enum PushOpener {
  static let version = 1
  static let label = Data("openorc push v1".utf8)

  static func open(_ envelope: PushEnvelope, phonePrivateKey: Data) throws -> PushNotice {
    try JSONDecoder().decode(PushNotice.self, from: plaintext(envelope, phonePrivateKey: phonePrivateKey, purpose: ""))
  }

  /// The Orcling's look sealed beside an alert as `f`, under its own associated data, so it never opens as a notice.
  static func openFace(_ envelope: PushEnvelope, phonePrivateKey: Data) throws -> OrclingLook {
    try JSONDecoder().decode(OrclingLook.self, from: plaintext(envelope, phonePrivateKey: phonePrivateKey, purpose: ".face"))
  }

  private static func plaintext(_ envelope: PushEnvelope, phonePrivateKey: Data, purpose: String) throws -> Data {
    guard envelope.v == version else { throw PushFailure.unknownVersion }
    guard let macRaw = Data(base64URL: envelope.m), let nonce = Data(base64URL: envelope.n), let sealed = Data(base64URL: envelope.c), sealed.count > 16 else { throw PushFailure.malformed }
    let mac = try Curve25519.KeyAgreement.PublicKey(rawRepresentation: macRaw)
    let phone = try Curve25519.KeyAgreement.PrivateKey(rawRepresentation: phonePrivateKey)
    let key = try phone.sharedSecretFromKeyAgreement(with: mac)
      .hkdfDerivedSymmetricKey(using: SHA256.self, salt: label, sharedInfo: Data("seal".utf8) + macRaw + phone.publicKey.rawRepresentation, outputByteCount: 32)
    let box = try AES.GCM.SealedBox(nonce: AES.GCM.Nonce(data: nonce), ciphertext: sealed.dropLast(16), tag: sealed.suffix(16))
    return try AES.GCM.open(box, using: key, authenticating: label + Data("\(purpose).\(envelope.m)".utf8))
  }
}

extension Data {
  init?(base64URL text: String) {
    var base64 = text.replacingOccurrences(of: "-", with: "+").replacingOccurrences(of: "_", with: "/")
    base64 += String(repeating: "=", count: (4 - base64.count % 4) % 4)
    self.init(base64Encoded: base64)
  }
}
