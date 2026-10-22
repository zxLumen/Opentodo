import XCTest

final class DragUITests: XCTestCase {
    func testReorderWithinGroupAndAcrossGroups() {
        let app = XCUIApplication()
        app.launchArguments = ["-UITestSeedGroups"]
        app.launch()

        let alpha = app.staticTexts["Alpha"].firstMatch
        let bravo = app.staticTexts["Bravo"].firstMatch
        let charlie = app.staticTexts["Charlie"].firstMatch
        XCTAssertTrue(alpha.waitForExistence(timeout: 8))
        XCTAssertTrue(bravo.exists)
        XCTAssertTrue(charlie.exists)

        // 1) 同组内：把 Bravo 拖到 Alpha 前面
        drag(app: app, sourceText: bravo, to: alpha)
        sleep(1)
        XCTAssertLessThan(
            app.staticTexts["Bravo"].firstMatch.frame.minY,
            app.staticTexts["Alpha"].firstMatch.frame.minY,
            "Bravo should be before Alpha after reorder"
        )

        // 2) 跨分组：把 Alpha 拖到 B 组的 Charlie 前
        drag(app: app, sourceText: app.staticTexts["Alpha"].firstMatch, to: app.staticTexts["Charlie"].firstMatch)
        sleep(1)

        let bHeader = app.staticTexts["B"].firstMatch
        XCTAssertTrue(bHeader.waitForExistence(timeout: 2), "missing B section header")
        XCTAssertGreaterThan(
            app.staticTexts["Alpha"].firstMatch.frame.minY,
            bHeader.frame.minY,
            "Alpha should have moved into group B"
        )

        // 3) 拖到分组标题：放到该分组末尾
        let delta = app.staticTexts["Delta"].firstMatch
        let aHeader = app.staticTexts["A"].firstMatch
        XCTAssertTrue(delta.exists)
        XCTAssertTrue(aHeader.exists)
        drag(app: app, sourceText: delta, to: aHeader)
        sleep(1)
        XCTAssertLessThan(
            app.staticTexts["Delta"].firstMatch.frame.minY,
            app.staticTexts["B"].firstMatch.frame.minY,
            "Delta should have moved to the end of group A"
        )
    }

    private func drag(app: XCUIApplication, sourceText: XCUIElement, to target: XCUIElement) {
        let window = app.windows.firstMatch
        let start = window.coordinate(withNormalizedOffset: CGVector(dx: 0.92, dy: 0))
            .withOffset(CGVector(dx: 0, dy: sourceText.frame.midY))
        start.press(forDuration: 0.7, thenDragTo: target.coordinate(withNormalizedOffset: CGVector(dx: 0.5, dy: 0.5)))
    }
}
