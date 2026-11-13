import CoreGraphics
import Foundation
import ImageIO

/// An Orcling's face drawn as the app draws it (OrclingFace.tsx): body, texture, eyes, glasses and accessory on a
/// 100-unit square, from OrclingArt's generated shapes.
enum OrclingFace {
  /// The face as a square PNG with a clear ground, `pixels` wide; nil when CoreGraphics cannot draw one.
  static func png(_ look: OrclingLook, pixels: Int = 192) -> Data? {
    guard let space = CGColorSpace(name: CGColorSpace.sRGB),
      let context = CGContext(data: nil, width: pixels, height: pixels, bitsPerComponent: 8, bytesPerRow: 0, space: space, bitmapInfo: CGImageAlphaInfo.premultipliedLast.rawValue)
    else { return nil }
    // SVG's y runs down: flip once, so the art's numbers read as they do in the app.
    let scale = CGFloat(pixels) / 100
    context.translateBy(x: 0, y: CGFloat(pixels))
    context.scaleBy(x: scale, y: -scale)
    draw(look, in: context, space: space)
    guard let image = context.makeImage() else { return nil }
    let data = NSMutableData()
    guard let destination = CGImageDestinationCreateWithData(data, "public.png" as CFString, 1, nil) else { return nil }
    CGImageDestinationAddImage(destination, image, nil)
    return CGImageDestinationFinalize(destination) ? data as Data : nil
  }

  private static func draw(_ look: OrclingLook, in context: CGContext, space: CGColorSpace) {
    let body = path(OrclingArt.shapes.indices.contains(look.shape) ? OrclingArt.shapes[look.shape] : OrclingArt.shapes[0])
    fill(body, color(look.bodyColor), in: context)
    texture(look, body: body, in: context, space: space)
    let eyes = OrclingArt.eyes.indices.contains(look.eyes) ? OrclingArt.eyes[look.eyes] : OrclingArt.eyes[0]
    fill(path(eyes.path), color(look.eyeColor), in: context)
    fill(path(eyes.glints), color(OrclingArt.light), in: context)
    if OrclingArt.glasses.indices.contains(look.glasses), let glasses = OrclingArt.glasses[look.glasses] {
      fill(path(glasses.lenses), color(OrclingArt.lens), in: context)
      context.addPath(path(glasses.frames))
      context.setStrokeColor(color(look.eyeColor))
      context.setLineWidth(3)
      context.setLineCap(.round)
      context.strokePath()
    }
    if OrclingArt.accessories.indices.contains(look.accessory), let accessory = OrclingArt.accessories[look.accessory] {
      fill(path(accessory.path), color(accessory.fill), in: context)
      if let detail = accessory.detail { fill(path(detail.path), color(detail.fill), in: context) }
    }
  }

  /// Light from the top left and shade at the bottom right over the body; a gloss spot, or a fuzzy edge of dots.
  private static func texture(_ look: OrclingLook, body: CGPath, in context: CGContext, space: CGColorSpace) {
    guard look.texture != 0 else { return }
    let light = look.texture == 2 ? 0.45 : 0.3
    let colors = [color(OrclingArt.light, alpha: light), color(OrclingArt.light, alpha: 0), color(OrclingArt.shade, alpha: 0.18)] as CFArray
    if let gradient = CGGradient(colorsSpace: space, colors: colors, locations: [0, 0.55, 1]) {
      // As SVG's objectBoundingBox gradient: centered at (0.32, 0.28) of the body's box, 0.8 of it wide.
      let box = body.boundingBox
      context.saveGState()
      context.addPath(body)
      context.clip()
      context.translateBy(x: box.minX, y: box.minY)
      context.scaleBy(x: box.width, y: box.height)
      let center = CGPoint(x: 0.32, y: 0.28)
      context.drawRadialGradient(gradient, startCenter: center, startRadius: 0, endCenter: center, endRadius: 0.8, options: [.drawsAfterEndLocation])
      context.restoreGState()
    }
    if look.texture == 2 {
      context.saveGState()
      context.translateBy(x: 35, y: 28)
      context.rotate(by: -24 * .pi / 180)
      context.setFillColor(color(OrclingArt.light, alpha: 0.7))
      context.fillEllipse(in: CGRect(x: -9, y: -5, width: 18, height: 10))
      context.restoreGState()
    }
    if look.texture == 3 {
      context.saveGState()
      context.addPath(body)
      context.setStrokeColor(color(look.bodyColor))
      context.setLineWidth(7)
      context.setLineCap(.round)
      context.setLineDash(phase: 0, lengths: [0.1, 5.5])
      context.strokePath()
      context.restoreGState()
    }
  }

  private static func fill(_ shape: CGPath, _ ink: CGColor, in context: CGContext) {
    guard !shape.isEmpty else { return }
    context.addPath(shape)
    context.setFillColor(ink)
    context.fillPath()
  }

  static func path(_ steps: [PathStep]) -> CGPath {
    let shape = CGMutablePath()
    for step in steps {
      switch step {
      case .move(let x, let y): shape.move(to: CGPoint(x: x, y: y))
      case .line(let x, let y): shape.addLine(to: CGPoint(x: x, y: y))
      case .quad(let cx, let cy, let x, let y): shape.addQuadCurve(to: CGPoint(x: x, y: y), control: CGPoint(x: cx, y: cy))
      case .cubic(let c1x, let c1y, let c2x, let c2y, let x, let y):
        shape.addCurve(to: CGPoint(x: x, y: y), control1: CGPoint(x: c1x, y: c1y), control2: CGPoint(x: c2x, y: c2y))
      case .close: shape.closeSubpath()
      }
    }
    return shape
  }

  /// "#rgb" or "#rrggbb" in sRGB; black for anything else.
  static func color(_ hex: String, alpha: CGFloat = 1) -> CGColor {
    var digits = hex.hasPrefix("#") ? String(hex.dropFirst()) : hex
    if digits.count == 3 { digits = digits.map { "\($0)\($0)" }.joined() }
    let value = digits.count == 6 ? UInt32(digits, radix: 16) ?? 0 : 0
    let channel = { (shift: UInt32) in CGFloat((value >> shift) & 0xff) / 255 }
    return CGColor(srgbRed: channel(16), green: channel(8), blue: channel(0), alpha: alpha)
  }
}
