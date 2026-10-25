import Foundation

// Reads packages/link/src/test-fixtures/push-vectors.json on stdin, opens every vector with the extension's own
// PushOpener.swift, and prints what each gave for push-vectors.test.mts to compare.

struct Vectors: Decodable {
  struct Phone: Decodable { let privateKey: String }
  struct Vector: Decodable { let name: String; let envelope: PushEnvelope }
  let phone: Phone
  let good: [Vector]
  let bad: [Vector]
}

func dictionary(_ notice: PushNotice) -> [String: Any] {
  var out: [String: Any] = ["id": notice.id, "kind": notice.kind, "threadId": notice.threadId.map { $0 as Any } ?? NSNull(), "title": notice.title, "body": notice.body]
  if let approval = notice.approval { out["approval"] = ["runId": approval.runId, "approvalId": approval.approvalId] }
  return out
}

func result(_ vector: Vectors.Vector, key: Data) -> [String: Any] {
  do {
    return ["name": vector.name, "notice": dictionary(try PushOpener.open(vector.envelope, phonePrivateKey: key))]
  } catch {
    return ["name": vector.name, "error": String(describing: error)]
  }
}

let vectors = try JSONDecoder().decode(Vectors.self, from: FileHandle.standardInput.readDataToEndOfFile())
guard let key = Data(base64URL: vectors.phone.privateKey) else { fatalError("The phone key is not base64url.") }
let report = ["good": vectors.good.map { result($0, key: key) }, "bad": vectors.bad.map { result($0, key: key) }]
FileHandle.standardOutput.write(try JSONSerialization.data(withJSONObject: report))
