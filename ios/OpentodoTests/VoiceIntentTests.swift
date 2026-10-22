import XCTest
@testable import Opentodo

final class VoiceIntentTests: XCTestCase {
    func testBarePhraseBecomesTodo() {
        XCTAssertEqual(VoiceIntent.parse("买牛奶"), .add("买牛奶"))
    }

    func testAddPrefixes() {
        XCTAssertEqual(VoiceIntent.parse("加一条 买牛奶"), .add("买牛奶"))
        XCTAssertEqual(VoiceIntent.parse("帮我记一下明天交周报"), .add("明天交周报"))
        XCTAssertEqual(VoiceIntent.parse("提醒我下午三点开会。"), .add("下午三点开会"))
    }

    func testActions() {
        XCTAssertEqual(VoiceIntent.parse("完成买牛奶"), .complete("买牛奶"))
        XCTAssertEqual(VoiceIntent.parse("搞定 周报"), .complete("周报"))
        XCTAssertEqual(VoiceIntent.parse("删除买牛奶"), .remove("买牛奶"))
        XCTAssertEqual(VoiceIntent.parse("归档周报"), .archive("周报"))
        XCTAssertEqual(VoiceIntent.parse("恢复周报"), .reopen("周报"))
    }

    func testAmbiguousWordsStayAsTodo() {
        XCTAssertEqual(VoiceIntent.parse("完成情况汇报"), .complete("情况汇报"))
        // 纯名词不会被误判成动作
        XCTAssertEqual(VoiceIntent.parse("买菜"), .add("买菜"))
    }
}
