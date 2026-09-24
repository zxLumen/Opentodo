import SwiftUI
import AppKit

/// App 图标：直接画"悬浮球"（ringC 样式）——白色球体 + 蓝色进度环 + checklist 图标。
/// 通过 `Opentodo --export-icon <path>` 导出为 PNG，构建脚本再用它生成 .icns。
struct AppIconView: View {
    var size: CGFloat = 1024

    private var d: CGFloat { size * 0.80 }
    private var ring: CGFloat { d * 5.0 / 64.0 }
    private var inset: CGFloat { d * 4.0 / 64.0 }
    private var glyph: CGFloat { d * 22.0 / 64.0 }

    private let blue1 = Color(hex: 0x4F8DFD)
    private let blue2 = Color(hex: 0x2F6BE0)

    var body: some View {
        ZStack {
            Circle()
                .fill(.white)
                .shadow(color: .black.opacity(0.22), radius: d * 7.0 / 64.0, y: d * 2.0 / 64.0)
            Circle()
                .trim(from: 0, to: 0.68)
                .stroke(blue1, style: StrokeStyle(lineWidth: ring, lineCap: .round))
                .rotationEffect(.degrees(-90))
                .padding(inset)
            Image(systemName: "checklist")
                .font(.system(size: glyph, weight: .semibold))
                .foregroundStyle(blue2)
        }
        .frame(width: d, height: d)
        .frame(width: size, height: size)
    }
}

@MainActor
enum AppIcon {
    /// 渲染图标到 PNG（透明背景）。
    static func export(to path: String) {
        let renderer = ImageRenderer(content: AppIconView(size: 1024))
        renderer.scale = 1
        guard let cg = renderer.cgImage else { return }
        let rep = NSBitmapImageRep(cgImage: cg)
        rep.size = NSSize(width: 1024, height: 1024)
        if let data = rep.representation(using: .png, properties: [:]) {
            try? data.write(to: URL(fileURLWithPath: path))
        }
    }
}
