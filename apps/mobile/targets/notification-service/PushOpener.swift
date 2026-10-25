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

enum PushFailure: Error { case unknownVersion, malformed }

enum PushOpener {
  static let version = 1
  static let label = Data("openorc push v1".utf8)

  static func open(_ envelope: PushEnvelope, phonePrivateKey: Data) throws -> PushNotice {
    guard envelope.v == version else { throw PushFailure.unknownVersion }
    guard let macRaw = Data(base64URL: envelope.m), let nonce = Data(base64URL: envelope.n), let sealed = Data(base64URL: envelope.c), sealed.count > 16 else { throw PushFailure.malformed }
    let mac = try Curve25519.KeyAgreement.PublicKey(rawRepresentation: macRaw)
    let phone = try Curve25519.KeyAgreement.PrivateKey(rawRepresentation: phonePrivateKey)
    let key = try phone.sharedSecretFromKeyAgreement(with: mac)
      .hkdfDerivedSymmetricKey(using: SHA256.self, salt: label, sharedInfo: Data("seal".utf8) + macRaw + phone.publicKey.rawRepresentation, outputByteCount: 32)
    let box = try AES.GCM.SealedBox(nonce: AES.GCM.Nonce(data: nonce), ciphertext: sealed.dropLast(16), tag: sealed.suffix(16))
    let plain = try AES.GCM.open(box, using: key, authenticating: label + Data(".\(envelope.m)".utf8))
    return try JSONDecoder().decode(PushNotice.self, from: plain)
  }
}

extension Data {
  init?(base64URL text: String) {
    var base64 = text.replacingOccurrences(of: "-", with: "+").replacingOccurrences(of: "_", with: "/")
    base64 += String(repeating: "=", count: (4 - base64.count % 4) % 4)
    self.init(base64Encoded: base64)
  }
}
