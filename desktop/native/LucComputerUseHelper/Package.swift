// swift-tools-version: 6.0
import PackageDescription

let package = Package(
    name: "LucComputerUseHelper",
    platforms: [.macOS(.v14)],
    products: [
        .executable(name: "luc-computer-use-helper", targets: ["LucComputerUseHelper"]),
    ],
    dependencies: [
        .package(url: "https://github.com/trycua/cua.git", revision: "d38bfbfb6b1d4296903477f517b1a0fa54af497b"),
        .package(url: "https://github.com/modelcontextprotocol/swift-sdk.git", from: "0.9.0"),
    ],
    targets: [
        .executableTarget(
            name: "LucComputerUseHelper",
            dependencies: [
                .product(name: "CuaDriverCore", package: "cua"),
                .product(name: "CuaDriverServer", package: "cua"),
                .product(name: "MCP", package: "swift-sdk"),
            ]
        ),
    ]
)
