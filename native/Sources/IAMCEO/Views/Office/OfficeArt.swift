import Foundation

// The office art, as data: string templates, one character per sprite pixel ('.' is transparent), and their
// palettes. Generated from the art set's sprites.json (art-A, "soft and squishy", with the art director's grafts);
// edit the art source and regenerate rather than editing by hand.
//
// One mascot for everyone: a round blob whose BODY COLOUR is its state. Frames carry the body roles, recoloured per
// state: o outline · O lit outline · s shade · b base · l light · h shine · c blush. Faces add the fixed roles
// E eye · W eye highlight · i lower-iris glint · M mouth line · m mouth inside (and the state's o and c). Each member
// wears one accessory, roles x line · a base · A shade · g light · k second colour · K its shade, coloured per
// accessory. OfficeSprites composes residents from these; OfficeMap and OfficeRender draw furniture, screens and fx.

/// The one accessory a member wears (the crown is the lead's alone).
enum OfficeAccessory: String, CaseIterable, Sendable {
    case crown, bow, beanie, cap, glasses, headphones, sprout, star, flower, antenna, party, tophat, catears
}

enum OfficeArt {
    /// A template stamped at an offset from an attach point.
    struct Overlay: Sendable {
        let dx: Int
        let dy: Int
        let rows: [String]
    }

    enum View: Sendable { case front, back, side }

    /// A finished resident frame (arms baked in, lit outline applied). `anchor` is the scene point the frame is pinned to
    /// (the floor under the body on foot; the desk's back edge behind a desk; the seat point on a chair). `head` is where
    /// accessories attach, `facePoint` where the face (and glasses) go; `face` and `blink` name the faces to stamp.
    struct Frame: Sendable {
        let anchorX: Int
        let anchorY: Int
        let view: View
        let headX: Int
        let headY: Int
        let faceX: Int
        let faceY: Int
        let face: String?
        let blink: String?
        let rows: [String]
    }

    /// An accessory: one overlay per view, attached to the head point (or to the face point: glasses).
    struct Accessory: Sendable {
        let onFace: Bool
        let palette: [Character: UInt32]
        let front: Overlay
        let back: Overlay
        let side: Overlay

        func overlay(_ view: View) -> Overlay {
            switch view {
            case .front: front
            case .back: back
            case .side: side
            }
        }
    }

    /// A piece of furniture (or a screen, an fx): rows plus its own palette.
    struct Piece: Sendable {
        let rows: [String]
        let palette: [Character: UInt32]
        var width: Int { rows.first?.count ?? 0 }
        var height: Int { rows.count }
    }

    // MARK: Palettes

    /// The body colour IS the state: per state, the body roles in the order o s b l h c O.
    static let states: [String: [UInt32]] = [
        "working": [0x2E2170, 0x8E78EE, 0xB9A8FF, 0xD9CFFF, 0xF6F2FF, 0xF59BC8, 0x5944B4],
        "waiting": [0x6A3A0C, 0xF09A3C, 0xFFBC5E, 0xFFD58F, 0xFFF5DF, 0xF5788E, 0xA26220],
        "blocked": [0x7C1C34, 0xF0646E, 0xFF8A8C, 0xFFB0AF, 0xFFE9E8, 0xE8507A, 0xAD3A4C],
        "error": [0x450C1E, 0xA0283C, 0xD23C4E, 0xE8687A, 0xF7C0C7, 0x8E2448, 0x7A1F33],
        "idle": [0x433E5E, 0x9C98B6, 0xC3C0D6, 0xE0DEEC, 0xF7F6FB, 0xE6ADCA, 0x726D96],
        "asleep": [0x25214A, 0x58547F, 0x726E9C, 0x8C88B5, 0xAAA6CC, 0x9A7FAA, 0x433E69],
    ]
    static let stateRoles: [Character] = ["o", "s", "b", "l", "h", "c", "O"]
    /// Face colours, the same for everyone.
    static let faceFixed: [Character: UInt32] = ["E": 0x24163F, "W": 0xFFFFFF, "i": 0x6C55C9, "M": 0x4A1631, "m": 0xFF7FA8]

    // MARK: Faces (12-wide overlays stamped at a frame's face point)

    static let faces: [String: [String]] = [
        "open": [
            "............",
            "..WE....WE..",
            "..EE....EE..",
            "..Ei....Ei..",
            ".cc.M..M.cc.",
            ".....MM.....",
        ],
        "blink": [
            "............",
            "............",
            "............",
            "..EE....EE..",
            ".cc.M..M.cc.",
            ".....MM.....",
        ],
        "focus": [
            "............",
            "............",
            "..WE....WE..",
            "..EE....EE..",
            ".cc..MM..cc.",
            "............",
        ],
        "hopeful": [
            "..WE....WE..",
            "..EE....EE..",
            "..EW....EW..",
            "............",
            ".cc..MM..cc.",
            ".....mm.....",
        ],
        "urgent": [
            "............",
            "..WE....WE..",
            "..EE....EE..",
            "..Ei....Ei..",
            ".cc.MMMM.cc.",
            ".....mm.....",
        ],
        "dizzy": [
            "............",
            ".E.E....E.E.",
            "..E......E..",
            ".E.E....E.E.",
            "....M.M.....",
            ".....M.M....",
        ],
        "content": [
            "............",
            "............",
            "..E......E..",
            ".E.E....E.E.",
            "cc..M..M..cc",
            ".....MM.....",
        ],
        "sleep": [
            "............",
            "............",
            "............",
            ".EEE....EEE.",
            "cc........cc",
            ".....MM.....",
        ],
        "focus_blink": [
            "............",
            "............",
            "............",
            "..EE....EE..",
            ".cc..MM..cc.",
            "............",
        ],
        "hopeful_blink": [
            "............",
            "............",
            "..EE....EE..",
            "............",
            ".cc..MM..cc.",
            ".....mm.....",
        ],
        "side_open": [
            "............",
            ".WE.........",
            ".EE.........",
            ".Ei.........",
            "...cc.......",
            "MM..........",
        ],
        "side_blink": [
            "............",
            "............",
            "............",
            ".EE.........",
            "...cc.......",
            "MM..........",
        ],
    ]

    // MARK: Accessories (front, back and side views; side views face left)

    static let accessories: [OfficeAccessory: Accessory] = [
        .crown: Accessory(
            onFace: false, palette: ["x": 0x6B4518, "a": 0xF5C98B, "A": 0xD9A55E, "g": 0xFFEBC2, "k": 0xFF6FB8],
            front: Overlay(dx: -4, dy: -5, rows: [
                ".x.xx.x.",
                "xgxggxgx",
                "xaaaaaax",
                "xakaakax",
                "xAAAAAAx",
                ".xxxxxx.",
            ]),
            back: Overlay(dx: -4, dy: -5, rows: [
                ".x.xx.x.",
                "xgxggxgx",
                "xaaaaaax",
                "xakaakax",
                "xAAAAAAx",
                ".xxxxxx.",
            ]),
            side: Overlay(dx: -4, dy: -5, rows: [
                ".x.xx.x.",
                "xgxggxgx",
                "xaaaaaax",
                "xakaakax",
                "xAAAAAAx",
                ".xxxxxx.",
            ])
        ),
        .bow: Accessory(
            onFace: false, palette: ["x": 0x6A1B45, "a": 0xFF6FB8, "A": 0xD94A93, "g": 0xFFB3DA, "k": 0xA82C6C],
            front: Overlay(dx: 1, dy: -2, rows: [
                "xx...xx",
                "xgxxxax",
                "xaakaAx",
                "xAxxxAx",
                "xx...xx",
            ]),
            back: Overlay(dx: -8, dy: -2, rows: [
                "xx...xx",
                "xaxxxgx",
                "xAakaax",
                "xAxxxAx",
                "xx...xx",
            ]),
            side: Overlay(dx: 1, dy: -2, rows: [
                "xx...xx",
                "xgxxxax",
                "xaakaAx",
                "xAxxxAx",
                "xx...xx",
            ])
        ),
        .beanie: Accessory(
            onFace: false, palette: ["x": 0x1F4B63, "a": 0xA8ECFF, "A": 0x6CB8D4, "g": 0xE4FAFF, "k": 0x86D6EE, "K": 0x5BA8C6],
            front: Overlay(dx: -8, dy: -3, rows: [
                ".......xx.......",
                "......xggx......",
                "....xxxggxxx....",
                "...xgaaaaaaAx...",
                "..xgaaaaaaaaAx..",
                ".xkKkKkKkKkKkKx.",
                ".xxxxxxxxxxxxxx.",
            ]),
            back: Overlay(dx: -8, dy: -3, rows: [
                ".......xx.......",
                "......xggx......",
                "....xxxggxxx....",
                "...xAaaaaaagx...",
                "..xAaaaaaaaagx..",
                ".xKkKkKkKkKkKkx.",
                ".xxxxxxxxxxxxxx.",
            ]),
            side: Overlay(dx: -8, dy: -3, rows: [
                ".......xx.......",
                "......xggx......",
                "....xxxggxxx....",
                "...xgaaaaaaAx...",
                "..xgaaaaaaaaAx..",
                ".xkKkKkKkKkKkKx.",
                ".xxxxxxxxxxxxxx.",
            ])
        ),
        .cap: Accessory(
            onFace: false, palette: ["x": 0x17523F, "a": 0x6FE3B2, "A": 0x3FB38D, "g": 0xC2F6E0, "k": 0x2E9A75, "K": 0x1F7558],
            front: Overlay(dx: -8, dy: -2, rows: [
                "......xxxx......",
                "....xxagaaxx....",
                "...xgaaaaaaAx...",
                "..xaaaaaaaaaAx..",
                ".xxxxxxxxxxxxxx.",
                "xkkkkkkkkkkkkkKx",
                ".xxxxxxxxxxxxxx.",
            ]),
            back: Overlay(dx: -8, dy: -2, rows: [
                "......xxxx......",
                "....xxaagaxx....",
                "...xgaaaaaaAx...",
                "..xaaaaaaaaaAx..",
                ".xaaaaxxxxaaaAx.",
                ".xxxxx....xxxxx.",
            ]),
            side: Overlay(dx: -12, dy: -2, rows: [
                ".........xxxx......",
                ".......xxaagaxx....",
                "......xgaaaaaaAx...",
                ".....xaaaaaaaaaAx..",
                "xxxxxxxxxxxxxxxxAx.",
                "xkkkkkKxxxxxxxxxx..",
                ".xxxxxx............",
            ])
        ),
        .glasses: Accessory(
            onFace: true, palette: ["x": 0x2B2456, "g": 0xE8FBFF],
            front: Overlay(dx: 0, dy: 0, rows: [
                ".xxx....xxx.",
                "xg..xxxx..gx",
                "x...x..x...x",
                "x...x..x...x",
                ".xxx....xxx.",
            ]),
            back: Overlay(dx: -2, dy: 2, rows: [
                ".xx..........xx.",
            ]),
            side: Overlay(dx: 0, dy: 0, rows: [
                ".xxx........",
                "x..gxxxxx...",
                "x...x.......",
                "x...x.......",
                ".xxx........",
            ])
        ),
        .headphones: Accessory(
            onFace: false, palette: ["x": 0x211B42, "a": 0x7B72C4, "A": 0x4E4699, "k": 0xFF6FB8, "K": 0xCF4C93, "g": 0xFFC2E0],
            front: Overlay(dx: -9, dy: -1, rows: [
                "......xxxxxx......",
                "....xxaaaaaaxx....",
                "...xax......xAx...",
                "..xax........xAx..",
                "..xx..........xx..",
                ".xxx..........xxx.",
                "xgkx..........xkKx",
                "xkkx..........xkKx",
                "xkKx..........xKKx",
                ".xx............xx.",
            ]),
            back: Overlay(dx: -9, dy: -1, rows: [
                "......xxxxxx......",
                "....xxaaaaaaxx....",
                "...xAx......xax...",
                "..xAx........xax..",
                "..xx..........xx..",
                ".xxx..........xxx.",
                "xKkx..........xkgx",
                "xKkx..........xkkx",
                "xKKx..........xKkx",
                ".xx............xx.",
            ]),
            side: Overlay(dx: 0, dy: -1, rows: [
                ".xx..",
                "..x..",
                "..x..",
                "..x..",
                "..x..",
                "xxxxx",
                "xgkKx",
                "xkkKx",
                "xkKKx",
                ".xxx.",
            ])
        ),
        .sprout: Accessory(
            onFace: false, palette: ["x": 0x1A5442, "a": 0x6FE3B2, "A": 0x3FB38D, "g": 0xC8F7E4, "k": 0x2E8A6B],
            front: Overlay(dx: -4, dy: -4, rows: [
                ".xx..xx.",
                "xgaxxaAx",
                ".xxkkxx.",
                "...kk...",
            ]),
            back: Overlay(dx: -4, dy: -4, rows: [
                ".xx..xx.",
                "xAaxxagx",
                ".xxkkxx.",
                "...kk...",
            ]),
            side: Overlay(dx: -4, dy: -4, rows: [
                ".xx..xx.",
                "xgaxxaAx",
                ".xxkkxx.",
                "...kk...",
            ])
        ),
        .star: Accessory(
            onFace: false, palette: ["x": 0x1F4B63, "a": 0xA8ECFF, "A": 0x6CB8D4, "g": 0xE4FAFF, "k": 0xFFE27A],
            front: Overlay(dx: -9, dy: -3, rows: [
                "...x...",
                "..xgx..",
                "xxxaxxx",
                "xgakaAx",
                ".xaaAx.",
                ".xaxAx.",
                ".xx.xx.",
            ]),
            back: Overlay(dx: 2, dy: -3, rows: [
                "...x...",
                "..xgx..",
                "xxxaxxx",
                "xAakagx",
                ".xAaax.",
                ".xAxax.",
                ".xx.xx.",
            ]),
            side: Overlay(dx: -9, dy: -3, rows: [
                "...x...",
                "..xgx..",
                "xxxaxxx",
                "xgakaAx",
                ".xaaAx.",
                ".xaxAx.",
                ".xx.xx.",
            ])
        ),
        .flower: Accessory(
            onFace: false, palette: ["x": 0x6A1B45, "a": 0xFF6FB8, "A": 0xD94A93, "g": 0xFFE27A, "k": 0x6FE3B2, "K": 0x1A5442],
            front: Overlay(dx: -8, dy: -3, rows: [
                "..x....",
                ".xax...",
                "xagax..",
                ".xaxk..",
                "..xkKx.",
                "....x..",
            ]),
            back: Overlay(dx: 1, dy: -3, rows: [
                "....x..",
                "...xax.",
                "..xagax",
                "..kxax.",
                ".xKkx..",
                "..x....",
            ]),
            side: Overlay(dx: -8, dy: -3, rows: [
                "..x....",
                ".xax...",
                "xagax..",
                ".xaxk..",
                "..xkKx.",
                "....x..",
            ])
        ),
        .antenna: Accessory(
            onFace: false, palette: ["x": 0x1F4B63, "a": 0xA8ECFF, "A": 0x6CB8D4, "g": 0xFFFFFF, "k": 0x2B2456],
            front: Overlay(dx: -2, dy: -6, rows: [
                ".xxx.",
                "xgaAx",
                "xaAAx",
                ".xxx.",
                "..k..",
                "..k..",
            ]),
            back: Overlay(dx: -3, dy: -6, rows: [
                ".xxx.",
                "xAagx",
                "xAAax",
                ".xxx.",
                "..k..",
                "..k..",
            ]),
            side: Overlay(dx: -2, dy: -6, rows: [
                ".xxx.",
                "xgaAx",
                "xaAAx",
                ".xxx.",
                "..k..",
                "..k..",
            ])
        ),
        .party: Accessory(
            onFace: false, palette: ["x": 0x6A1B45, "a": 0xFF6FB8, "A": 0xD94A93, "k": 0xFFF1F8, "g": 0xA8ECFF],
            front: Overlay(dx: -3, dy: -7, rows: [
                "..xgx..",
                "...x...",
                "..xax..",
                "..xkx..",
                ".xaaAx.",
                ".xkkkx.",
                "xaaaaAx",
                "xxxxxxx",
            ]),
            back: Overlay(dx: -4, dy: -7, rows: [
                "..xgx..",
                "...x...",
                "..xax..",
                "..xkx..",
                ".xAaax.",
                ".xkkkx.",
                "xAaaaax",
                "xxxxxxx",
            ]),
            side: Overlay(dx: -3, dy: -7, rows: [
                "..xgx..",
                "...x...",
                "..xax..",
                "..xkx..",
                ".xaaAx.",
                ".xkkkx.",
                "xaaaaAx",
                "xxxxxxx",
            ])
        ),
        .tophat: Accessory(
            onFace: false, palette: ["x": 0x120E24, "a": 0x3A3266, "A": 0x28224D, "g": 0x6A62B0, "k": 0xFF6FB8, "K": 0xCF4C93],
            front: Overlay(dx: -5, dy: -7, rows: [
                "..xxxxxx..",
                "..xgaaAx..",
                "..xaaaAx..",
                "..xkkkKx..",
                "xxxxxxxxxx",
                "xgaaaaaaAx",
                ".xxxxxxxx.",
            ]),
            back: Overlay(dx: -5, dy: -7, rows: [
                "..xxxxxx..",
                "..xAaagx..",
                "..xAaaax..",
                "..xKkkkx..",
                "xxxxxxxxxx",
                "xAaaaaaagx",
                ".xxxxxxxx.",
            ]),
            side: Overlay(dx: -5, dy: -7, rows: [
                "..xxxxxx..",
                "..xgaaAx..",
                "..xaaaAx..",
                "..xkkkKx..",
                "xxxxxxxxxx",
                "xgaaaaaaAx",
                ".xxxxxxxx.",
            ])
        ),
        .catears: Accessory(
            onFace: false, palette: ["x": 0x241D48, "a": 0xF5F2FF, "A": 0xC9C2E6, "k": 0xFF9EC7, "K": 0xE07AAE],
            front: Overlay(dx: -7, dy: -3, rows: [
                "x............x",
                "xx..........xx",
                "xax........xAx",
                "xkax......xAKx",
                ".xkxxxxxxxxKxx",
            ]),
            back: Overlay(dx: -7, dy: -3, rows: [
                "x............x",
                "xx..........xx",
                "xAx........xax",
                "xKAx......xakx",
                "xxKxxxxxxxxkx.",
            ]),
            side: Overlay(dx: -7, dy: -3, rows: [
                "x............x",
                "xx..........xx",
                "xax........xAx",
                "xkax......xAKx",
                ".xkxxxxxxxxKxx",
            ])
        ),
    ]
    /// Members draw from these in turn (by member id); the crown is never among them.
    static let accessoryOrder: [OfficeAccessory] = [.bow, .beanie, .cap, .glasses, .headphones, .sprout, .star, .flower, .antenna, .party, .tophat, .catears]

    // MARK: Furniture (each piece with its own palette; '@' is a state light, coloured at draw time)

    /// A member desk (28x13).
    static let desk = Piece(rows: [
        ".KKKKKKKKKKKKKKKKKKKKKKKKKK.",
        "KAAAAAAAAAAAAAAAAAAAAAAAAAAK",
        "KBBBBBBBBBBBBBBBBBBBBBBBBBBK",
        "KBBBBBBBBBBBBBBBBBBBBBBBBBBK",
        "KBBBBBBBBBBBBBBBBBBBBBBBBBBK",
        "KCCCCCCCCCCCCCCCCCCCCCCCCCCK",
        "KKKKKKKKKKKKKKKKKKKKKKKKKKKK",
        "KDDDDDDDDDDDDDDDDDDDDDDDDDDK",
        "KFFFFFFFFFFFFFFFFFFFFFFFFFFK",
        "KGGGGGGGGGGGGGGGGGGGGGGGGGGK",
        "KKKKKKKKKKKKKKKKKKKKKKKKKKKK",
        ".KEeK..................KEeK.",
        ".KKKK..................KKKK.",
    ], palette: ["K": 0x1A1433, "A": 0x7466B4, "B": 0x5B4F98, "C": 0x4E4388, "D": 0x4A3F80, "F": 0x3B316D, "G": 0x30285B, "E": 0x433A78, "e": 0x28214C])
    /// The lead's desk (47x14): the lead sits behind it, two monitor backs flank the face.
    static let deskLead = Piece(rows: [
        ".KKKKKKKKKKKKKKKKKKKKKKKKKKKKKKKKKKKKKKKKKKKKK.",
        "KAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAK",
        "KBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBK",
        "KBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBK",
        "KBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBK",
        "KCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCK",
        "KKKKKKKKKKKKKKKKKKKKKKKKKKKKKKKKKKKKKKKKKKKKKKK",
        "KDDDDDDDDDDDDDDDDDDDDDDDDDDDDDDDDDDDDDDDDDDDDDK",
        "KFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFK",
        "KFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFK",
        "KGGGGGGGGGGGGGGGGGGGGGGGGGGGGGGGGGGGGGGGGGGGGGK",
        "KKKKKKKKKKKKKKKKKKKKKKKKKKKKKKKKKKKKKKKKKKKKKKK",
        ".KEeK.....................................KEeK.",
        ".KKKK.....................................KKKK.",
    ], palette: ["K": 0x1A1433, "A": 0x7466B4, "B": 0x5B4F98, "C": 0x4E4388, "D": 0x4A3F80, "F": 0x3B316D, "G": 0x30285B, "E": 0x433A78, "e": 0x28214C])
    /// A laptop lid seen from behind (top row), drawn after the resident at desk (9, -2). '@' is the state LED.
    static let lid = Piece(rows: [
        ".KKKKKKKK.",
        "KjjjjjjjUK",
        "KjJJ@@JJUK",
        "KjJJJJJJUK",
        "KUUUUUUUUK",
        "KuuuuuuuuK",
        ".KKKKKKKK.",
    ], palette: ["K": 0x1A1433, "j": 0xB2A8E2, "J": 0x8C82C6, "U": 0x7067A8, "u": 0x2E2559, "@": 0x4A3F82])
    /// The shut laptop of a top-row resident in error or asleep on the desk, at desk (9, 2).
    static let lidClosed = Piece(rows: [
        ".KKKKKKKK.",
        "KjjjjjjjjK",
        "KUUUU@@UUK",
        ".KKKKKKKK.",
    ], palette: ["K": 0x1A1433, "j": 0xB2A8E2, "U": 0x7067A8, "@": 0x4A3F82])
    /// A monitor facing the viewer (bottom row) at desk (5, -8); its screen is desk (7, -6), 14x5.
    static let monitor = Piece(rows: [
        ".KKKKKKKKKKKKKKKK.",
        "KnnnnnnnnnnnnnnnnK",
        "Kn##############NK",
        "Kn##############NK",
        "Kn##############NK",
        "Kn##############NK",
        "Kn##############NK",
        "KNNNNNNNNNNNNNNNNK",
        ".KKKKKKKKKKKKKKKK.",
        "........KnK.......",
        "......KKnNKK......",
        "......KKKKKK......",
    ], palette: ["K": 0x1A1433, "N": 0x2C2554, "n": 0x443B7A, "#": 0x1B1631])
    /// The lead's monitors from behind, at lead desk (3, -8) and (32, -8).
    static let monitorBack = Piece(rows: [
        ".KKKKKKKKKK.",
        "KnnnnnnnnnNK",
        "KnNNNNNNNNNK",
        "KnNKKKKKKNNK",
        "KnNNNNNNNNNK",
        "KnNKKKKKKNNK",
        "KnNNNNN@@NNK",
        "KNNNNNNNNNNK",
        ".KKKKKKKKKK.",
        ".....KnK....",
        "...KKnNNKK..",
        "...KKKKKKK..",
    ], palette: ["K": 0x1A1433, "N": 0x2C2554, "n": 0x443B7A, "@": 0x4A3F82])
    /// The keyboard on a bottom-row desk, at desk (8, 3).
    static let keyboard = Piece(rows: [
        "KKKKKKKKKKKK",
        "KqQqQqQqQqQK",
        "KKKKKKKKKKKK",
    ], palette: ["K": 0x1A1433, "Q": 0x2A2350, "q": 0x6A5FA6])
    /// A desk chair facing the viewer: an empty top-row seat; a bottom-row resident turned around sits on it at desk (6, 9).
    static let chairFront = Piece(rows: [
        "...KKKKKKKKKK...",
        "..KwcccccccchK..",
        ".KcchhhhhhhhhdK.",
        ".KchhhhhhhhhhdK.",
        ".KchhhhhhhhhhdK.",
        ".KchhhhhhhhhhdK.",
        ".KchhhhhhhhhhdK.",
        ".KhhhhhhhhhhddK.",
        "..KddddddddddK..",
        "..KKKKKKKKKKKK..",
        ".KcccccccccchhK.",
        ".KhhhhhhhhhhddK.",
        "..KKKKKKKKKKKK..",
        ".......KWK......",
        ".......KWK......",
        ".....KKWWWKK....",
        "..KKKWWWWWWWKKK.",
        ".KWWWWK...KWWWWK",
        ".KKK.........KKK",
        "..K...........K.",
    ], palette: ["K": 0x1A1433, "c": 0x504893, "h": 0x3C3573, "d": 0x2B2554, "w": 0x5E56A2, "W": 0x241D46, "p": 0x6A5EB0])
    /// A desk chair from behind (bottom row), drawn after the resident at desk (7, 18).
    static let chairBack = Piece(rows: [
        "..KKKKKKKKKK..",
        ".KwcccccccchK.",
        ".KchhhhhhhhdK.",
        ".KchhhhhhhhdK.",
        ".KchhhhhhhhdK.",
        ".KchhhhhhhhdK.",
        ".KddddddddddK.",
        "..KKKKKKKKKK..",
        "......KK......",
        "..KKKKKKKKKK..",
        "..K..K..K..K..",
    ], palette: ["K": 0x1A1433, "c": 0x504893, "h": 0x3C3573, "d": 0x2B2554, "w": 0x5E56A2, "W": 0x241D46, "p": 0x6A5EB0])
    /// The lead's tall chair, drawn first at (seat.x - 12, desk.y - 28).
    static let chairLead = Piece(rows: [
        "......KKKKKKKKKKKK......",
        "....KKwccccccccccchKK...",
        "..KKcchhhhhhhhhhhhhhdKK.",
        ".KcchhpppppppppppphhhddK",
        ".KchhphhhhhhhhhhhhphhddK",
        "KcchphhhhhhhhhhhhhhphddK",
        "KchhphhhhhhhhhhhhhhphddK",
        "KchhphhhhhhhhhhhhhhphddK",
        "KchhphhhhhhhhhhhhhhphddK",
        "KchhphhhhhhhhhhhhhhphddK",
        "KchhphhhhhhhhhhhhhhphddK",
        "KchhphhhhhhhhhhhhhhphddK",
        "KchhphhhhhhhhhhhhhhphddK",
        "KchhphhhhhhhhhhhhhhphddK",
        "KchhhpppppppppppppphhddK",
        "KchhhhhhhhhhhhhhhhhhhddK",
        "KdhhhhhhhhhhhhhhhhhhhddK",
        "KddddddddddddddddddddddK",
        ".KKKKKKKKKKKKKKKKKKKKKK.",
    ], palette: ["K": 0x1A1433, "c": 0x504893, "h": 0x3C3573, "d": 0x2B2554, "w": 0x5E56A2, "W": 0x241D46, "p": 0x6A5EB0])
    /// The context warning: an upright low battery on the desk's left end.
    static let battery = Piece(rows: [
        ".WW.",
        "WWWW",
        "WddW",
        "WddW",
        "WddW",
        "WrrW",
        "WWWW",
    ], palette: ["W": 0xE6DEFF, "d": 0x2A2148, "r": 0xFF6A3D])
    /// chairFront's seat front, drawn after a turned-around bottom-row resident.
    static let chairFrontLip = Piece(rows: [
        "................",
        "................",
        "................",
        "................",
        "................",
        "................",
        "................",
        "................",
        "................",
        "................",
        ".KcccccccccchhK.",
        ".KhhhhhhhhhhddK.",
        "..KKKKKKKKKKKK..",
        ".......KWK......",
        ".......KWK......",
        ".....KKWWWKK....",
        "..KKKWWWWWWWKKK.",
        ".KWWWWK...KWWWWK",
        ".KKK.........KKK",
        "..K...........K.",
    ], palette: ["K": 0x1A1433, "c": 0x504893, "h": 0x3C3573, "d": 0x2B2554, "w": 0x5E56A2, "W": 0x241D46, "p": 0x6A5EB0])

    // MARK: Screens (14x5, bottom-row monitors) and fx

    static let screenPalette: [Character: UInt32] = ["0": 0x2A1F66, "1": 0xC9BCFF, "2": 0xB4F0FF, "3": 0x9DEBD2, "4": 0x5A4AA8, "a": 0xFFB070, "W": 0xF1E9FF, "r": 0xFF8A80, "v": 0x7A5BFF, "g": 0x8F88B2, "E": 0x4A1230, "R": 0xFF5A62, "x": 0xFF9AA2]
    static let screenWaiting = Piece(rows: [
        "00000000000000",
        "04444404440000",
        "00444000000000",
        "000000aa000000",
        "00000000000000",
    ], palette: screenPalette)
    static let screenBlocked = Piece(rows: [
        "00000000000000",
        "00rrrrrrrrrr00",
        "00WWWWWWWWWW00",
        "00WvvWWWWggW00",
        "00000000000000",
    ], palette: screenPalette)
    static let screenError = Piece(rows: [
        "EEEEEEEEEEEEEE",
        "EEEERREERREEEE",
        "EEEEEERREEEEEE",
        "EEEERREERREEEE",
        "EEEEEEEEEEEEEE",
    ], palette: screenPalette)
    /// A teardrop (pointed top, round bottom) in a mid blue with a deep outline: apart from the icy sparkle and the
    /// ice-blue accessories by hue, value and shape.
    static let sweat = Piece(rows: [
        "..d..",
        ".dBd.",
        "dBBBd",
        "dwBBd",
        "dBBbd",
        ".ddd.",
    ], palette: ["d": 0x1D3F8C, "B": 0x5C9DF5, "b": 0x3F78D6, "w": 0xE6F1FF])
    static let sparkle0 = Piece(rows: [
        ".a.",
        "aga",
        ".a.",
    ], palette: ["a": 0xA8ECFF, "g": 0xFFFFFF])
    static let sparkle1 = Piece(rows: [
        "..a..",
        "..a..",
        "aagaa",
        "..a..",
        "..a..",
    ], palette: ["a": 0xA8ECFF, "g": 0xFFFFFF])
}

/// Every resident frame. Walks hop in 4 frames (right-facing walks mirror the side frames).
enum OfficeFrame: Int, CaseIterable, Sendable {
    case standFront, walkFront0, walkFront1, walkFront2, walkFront3, standBack
    case walkBack0, walkBack1, walkBack2, walkBack3, standSide, walkSide0
    case walkSide1, walkSide2, walkSide3, deskFrontType0, deskFrontType1, deskFrontType2
    case deskFrontWait0, deskFrontWait1, deskFrontBlocked0, deskFrontBlocked1, deskFrontError, deskBackType0
    case deskBackType1, deskBackType2, deskBackError, chairWait0, chairWait1, chairBlocked0
    case chairBlocked1, deskFrontRest0, deskFrontRest1, deskFrontSleep0, deskFrontSleep1, deskBackRest0
    case deskBackRest1, deskBackSleep0, deskBackSleep1

    var art: OfficeArt.Frame {
        switch self {
        case .standFront: .init(
            anchorX: 10, anchorY: 15, view: .front, headX: 10, headY: 0,
            faceX: 4, faceY: 5, face: "open", blink: "blink", rows: [
                ".......OOOOOo.......",
                ".....OOlllllboo.....",
                "....Olhhlllllbbo....",
                "...Olhlllllllbbbo...",
                "...Ollllllllbbbbo...",
                "..Ollllllbbbbbbbso..",
                "..Olllbbbbbbbbbbso..",
                "..Ollbbbbbbbbbbbso..",
                "..Olbbbbbbbbbbbsso..",
                ".Oobbbbbbbbbbbbssoo.",
                "Olbbbbbbbbbbbbbsssbo",
                "obbobbbbbbbbbsssosso",
                ".ooobbbbbbbsssssooo.",
                "....oossssssssoo....",
                "......oooooooo......",
            ])
        case .walkFront0: .init(
            anchorX: 11, anchorY: 12, view: .front, headX: 11, headY: 0,
            faceX: 5, faceY: 4, face: "open", blink: "blink", rows: [
                "........OOOOOo........",
                ".....OOOlllllbOoo.....",
                "....Olhhlllllllbbo....",
                "...Olhllllllllbbbbo...",
                "..Ollllllllbbbbbbbso..",
                ".OOlllllbbbbbbbbbbsoo.",
                "Olbllbbbbbbbbbbbbbssbo",
                "obblbbbbbbbbbbbbbsssso",
                ".oobbbbbbbbbbbbbbssoo.",
                "...obbbbbbbbbssssso...",
                "....oossssssssssoo....",
                "......oooooooooo......",
            ])
        case .walkFront1: .init(
            anchorX: 9, anchorY: 17, view: .front, headX: 9, headY: 0,
            faceX: 3, faceY: 6, face: "open", blink: "blink", rows: [
                "......OOOOOo......",
                "....OOlllllboo....",
                "...Olhhllllbbbo...",
                "...Olhlllllbbbo...",
                "..Olllllllbbbbso..",
                "..Ollllllbbbbbso..",
                "..Olllllbbbbbbso..",
                "..Ollllbbbbbbbso..",
                "..Ollbbbbbbbbbso..",
                "..Olbbbbbbbbbsso..",
                ".Oobbbbbbbbbbssoo.",
                "Olbbbbbbbbbbbsssbo",
                "obbbbbbbbbbbssssso",
                ".ooobbbbbbbsssooo.",
                "...obbbbbbsssso...",
                "....oossssssoo....",
                "......oooooo......",
            ])
        case .walkFront2: .init(
            anchorX: 10, anchorY: 18, view: .front, headX: 10, headY: 0,
            faceX: 4, faceY: 5, face: "open", blink: "blink", rows: [
                ".......OOOOOo.......",
                ".....OOlllllboo.....",
                "....Olhhlllllbbo....",
                "...Olhlllllllbbbo...",
                "...Ollllllllbbbbo...",
                "..Ollllllbbbbbbbso..",
                "..Olllbbbbbbbbbbso..",
                ".OOllbbbbbbbbbbbsoo.",
                "Olblbbbbbbbbbbbsssbo",
                "obbbbbbbbbbbbbbsssso",
                ".oobbbbbbbbbbbbssoo.",
                "...obbbbbbbbbssso...",
                "...obbbbbbbssssso...",
                "....oossssssssoo....",
                "......oooooooo......",
            ])
        case .walkFront3: .init(
            anchorX: 10, anchorY: 16, view: .front, headX: 10, headY: 0,
            faceX: 4, faceY: 5, face: "open", blink: "blink", rows: [
                ".......OOOOOo.......",
                ".....OOlllllboo.....",
                "....Olhhlllllbbo....",
                "...Olhlllllllbbbo...",
                "...Ollllllllbbbbo...",
                "..Ollllllbbbbbbbso..",
                "..Olllbbbbbbbbbbso..",
                "..Ollbbbbbbbbbbbso..",
                ".OOlbbbbbbbbbbbssoo.",
                "Olbbbbbbbbbbbbbsssbo",
                "obbbbbbbbbbbbbbsssso",
                ".ooobbbbbbbbbsssooo.",
                "...obbbbbbbssssso...",
                "....oossssssssoo....",
                "......oooooooo......",
            ])
        case .standBack: .init(
            anchorX: 10, anchorY: 15, view: .back, headX: 10, headY: 0,
            faceX: 4, faceY: 5, face: nil, blink: nil, rows: [
                ".......OOOOOo.......",
                ".....OOlllllboo.....",
                "....Olhhlllllbbo....",
                "...Olhlllllllbbbo...",
                "...Ollllllllbbbbo...",
                "..Ollllllbbbbbbbso..",
                "..Olllbbbbbbbbbbso..",
                "..Ollbbbbbbbbbbbso..",
                "..Olbbbbbbbbbbbsso..",
                ".Oobbbbbbbbbbbbssoo.",
                "Olbbbbbbbbbbbbbsssbo",
                "obbobbbbbbbbbsssosso",
                ".ooobbbbbbbsssssooo.",
                "....oossssssssoo....",
                "......oooooooo......",
            ])
        case .walkBack0: .init(
            anchorX: 11, anchorY: 12, view: .back, headX: 11, headY: 0,
            faceX: 5, faceY: 4, face: nil, blink: nil, rows: [
                "........OOOOOo........",
                ".....OOOlllllbOoo.....",
                "....Olhhlllllllbbo....",
                "...Olhllllllllbbbbo...",
                "..Ollllllllbbbbbbbso..",
                ".OOlllllbbbbbbbbbbsoo.",
                "Olbllbbbbbbbbbbbbbssbo",
                "obblbbbbbbbbbbbbbsssso",
                ".oobbbbbbbbbbbbbbssoo.",
                "...obbbbbbbbbssssso...",
                "....oossssssssssoo....",
                "......oooooooooo......",
            ])
        case .walkBack1: .init(
            anchorX: 9, anchorY: 17, view: .back, headX: 9, headY: 0,
            faceX: 3, faceY: 6, face: nil, blink: nil, rows: [
                "......OOOOOo......",
                "....OOlllllboo....",
                "...Olhhllllbbbo...",
                "...Olhlllllbbbo...",
                "..Olllllllbbbbso..",
                "..Ollllllbbbbbso..",
                "..Olllllbbbbbbso..",
                "..Ollllbbbbbbbso..",
                "..Ollbbbbbbbbbso..",
                "..Olbbbbbbbbbsso..",
                ".Oobbbbbbbbbbssoo.",
                "Olbbbbbbbbbbbsssbo",
                "obbbbbbbbbbbssssso",
                ".ooobbbbbbbsssooo.",
                "...obbbbbbsssso...",
                "....oossssssoo....",
                "......oooooo......",
            ])
        case .walkBack2: .init(
            anchorX: 10, anchorY: 18, view: .back, headX: 10, headY: 0,
            faceX: 4, faceY: 5, face: nil, blink: nil, rows: [
                ".......OOOOOo.......",
                ".....OOlllllboo.....",
                "....Olhhlllllbbo....",
                "...Olhlllllllbbbo...",
                "...Ollllllllbbbbo...",
                "..Ollllllbbbbbbbso..",
                "..Olllbbbbbbbbbbso..",
                ".OOllbbbbbbbbbbbsoo.",
                "Olblbbbbbbbbbbbsssbo",
                "obbbbbbbbbbbbbbsssso",
                ".oobbbbbbbbbbbbssoo.",
                "...obbbbbbbbbssso...",
                "...obbbbbbbssssso...",
                "....oossssssssoo....",
                "......oooooooo......",
            ])
        case .walkBack3: .init(
            anchorX: 10, anchorY: 16, view: .back, headX: 10, headY: 0,
            faceX: 4, faceY: 5, face: nil, blink: nil, rows: [
                ".......OOOOOo.......",
                ".....OOlllllboo.....",
                "....Olhhlllllbbo....",
                "...Olhlllllllbbbo...",
                "...Ollllllllbbbbo...",
                "..Ollllllbbbbbbbso..",
                "..Olllbbbbbbbbbbso..",
                "..Ollbbbbbbbbbbbso..",
                ".OOlbbbbbbbbbbbssoo.",
                "Olbbbbbbbbbbbbbsssbo",
                "obbbbbbbbbbbbbbsssso",
                ".ooobbbbbbbbbsssooo.",
                "...obbbbbbbssssso...",
                "....oossssssssoo....",
                "......oooooooo......",
            ])
        case .standSide: .init(
            anchorX: 8, anchorY: 15, view: .side, headX: 8, headY: 0,
            faceX: 2, faceY: 5, face: "side_open", blink: "side_blink", rows: [
                ".....OOOOOo.......",
                "...OOlllllboo.....",
                "..Olhhlllllbbo....",
                ".Olhlllllllbbbo...",
                ".Ollllllllbbbbo...",
                "Ollllllbbbbbbbso..",
                "Olllbbbbbbbbbbso..",
                "Ollbbbbbbbbbbbso..",
                "Olbbbbbbbbbbbsso..",
                "obbbbbbbbbbbbssoo.",
                "obbbbbbbbbbbbsssbo",
                ".obbbbbbbbbsssosso",
                ".obbbbbbbsssssooo.",
                "..oossssssssoo....",
                "....oooooooo......",
            ])
        case .walkSide0: .init(
            anchorX: 9, anchorY: 12, view: .side, headX: 9, headY: 0,
            faceX: 3, faceY: 4, face: "side_open", blink: "side_blink", rows: [
                "......OOOOOo........",
                "...OOOlllllbOoo.....",
                "..Olhhlllllllbbo....",
                ".Olhllllllllbbbbo...",
                "Ollllllllbbbbbbbso..",
                "Olllllbbbbbbbbbbsoo.",
                "Ollbbbbbbbbbbbbbssbo",
                "Olbbbbbbbbbbbbbsssso",
                "obbbbbbbbbbbbbbssoo.",
                ".obbbbbbbbbssssso...",
                "..oossssssssssoo....",
                "....oooooooooo......",
            ])
        case .walkSide1: .init(
            anchorX: 7, anchorY: 17, view: .side, headX: 7, headY: 0,
            faceX: 1, faceY: 6, face: "side_open", blink: "side_blink", rows: [
                "....OOOOOo......",
                "..OOlllllboo....",
                ".Olhhllllbbbo...",
                ".Olhlllllbbbo...",
                "Olllllllbbbbso..",
                "Ollllllbbbbbso..",
                "Olllllbbbbbbso..",
                "Ollllbbbbbbbso..",
                "Ollbbbbbbbbbso..",
                "Olbbbbbbbbbsso..",
                "obbbbbbbbbbssoo.",
                "obbbbbbbbbbsssbo",
                "obbbbbbbbbssssso",
                ".obbbbbbbsssooo.",
                ".obbbbbbsssso...",
                "..oossssssoo....",
                "....oooooo......",
            ])
        case .walkSide2: .init(
            anchorX: 8, anchorY: 18, view: .side, headX: 8, headY: 0,
            faceX: 2, faceY: 5, face: "side_open", blink: "side_blink", rows: [
                ".....OOOOOo.......",
                "...OOlllllboo.....",
                "..Olhhlllllbbo....",
                ".Olhlllllllbbbo...",
                ".Ollllllllbbbbo...",
                "Ollllllbbbbbbbso..",
                "Olllbbbbbbbbbbso..",
                "Ollbbbbbbbbbbbsoo.",
                "Olbbbbbbbbbbbsssbo",
                "obbbbbbbbbbbbsssso",
                "obbbbbbbbbbbbssoo.",
                ".obbbbbbbbbssso...",
                ".obbbbbbbssssso...",
                "..oossssssssoo....",
                "....oooooooo......",
            ])
        case .walkSide3: .init(
            anchorX: 8, anchorY: 16, view: .side, headX: 8, headY: 0,
            faceX: 2, faceY: 5, face: "side_open", blink: "side_blink", rows: [
                ".....OOOOOo.......",
                "...OOlllllboo.....",
                "..Olhhlllllbbo....",
                ".Olhlllllllbbbo...",
                ".Ollllllllbbbbo...",
                "Ollllllbbbbbbbso..",
                "Olllbbbbbbbbbbso..",
                "Ollbbbbbbbbbbbso..",
                "Olbbbbbbbbbbbssoo.",
                "obbbbbbbbbbbbsssbo",
                "obbbbbbbbbbbbsssso",
                ".obbbbbbbbbsssooo.",
                ".obbbbbbbssssso...",
                "..oossssssssoo....",
                "....oooooooo......",
            ])
        case .deskFrontType0: .init(
            anchorX: 9, anchorY: 13, view: .front, headX: 9, headY: 0,
            faceX: 3, faceY: 5, face: "focus", blink: "focus_blink", rows: [
                "......OOOOOo......",
                "....OOlllllboo....",
                "...Olhhlllllbbo...",
                "..Olhlllllllbbbo..",
                "..Ollllllllbbbbo..",
                ".Ollllllbbbbbbbso.",
                ".Olllbbbbbbbbbbso.",
                ".Ollbbbbbbbbbbbso.",
                ".Olbbbbbbbbbbbsso.",
                ".obbbbbbbbbbbbsso.",
                ".obbbbbbbbbbbbsso.",
                "..obbbbbbbbbssso..",
                ".Oobbbbbbbsssssoo.",
                "Olbo..........osbo",
                ".oo............oo.",
            ])
        case .deskFrontType1: .init(
            anchorX: 9, anchorY: 13, view: .front, headX: 9, headY: 0,
            faceX: 3, faceY: 5, face: "focus", blink: "focus_blink", rows: [
                "......OOOOOo......",
                "....OOlllllboo....",
                "...Olhhlllllbbo...",
                "..Olhlllllllbbbo..",
                "..Ollllllllbbbbo..",
                ".Ollllllbbbbbbbso.",
                ".Olllbbbbbbbbbbso.",
                ".Ollbbbbbbbbbbbso.",
                ".Olbbbbbbbbbbbsso.",
                ".obbbbbbbbbbbbsso.",
                ".obbbbbbbbbbbbsso.",
                ".Oobbbbbbbbbssso..",
                "Olbobbbbbbsssssoo.",
                ".oo...........osbo",
                "...............oo.",
            ])
        case .deskFrontType2: .init(
            anchorX: 9, anchorY: 13, view: .front, headX: 9, headY: 0,
            faceX: 3, faceY: 5, face: "focus", blink: "focus_blink", rows: [
                "......OOOOOo......",
                "....OOlllllboo....",
                "...Olhhlllllbbo...",
                "..Olhlllllllbbbo..",
                "..Ollllllllbbbbo..",
                ".Ollllllbbbbbbbso.",
                ".Olllbbbbbbbbbbso.",
                ".Ollbbbbbbbbbbbso.",
                ".Olbbbbbbbbbbbsso.",
                ".obbbbbbbbbbbbsso.",
                ".obbbbbbbbbbbbsso.",
                "..obbbbbbbbbsssoo.",
                ".Oobbbbbbbssssosbo",
                "Olbo...........oo.",
                ".oo...............",
            ])
        case .deskFrontWait0: .init(
            anchorX: 9, anchorY: 13, view: .front, headX: 9, headY: 0,
            faceX: 3, faceY: 5, face: "hopeful", blink: "hopeful_blink", rows: [
                "......OOOOOo......",
                "....OOlllllboo....",
                "...Olhhlllllbbo...",
                "..Olhlllllllbbbo..",
                "..Ollllllllbbbbo..",
                ".Ollllllbbbbbbbso.",
                ".Olllbbbbbbbbbbso.",
                ".Ollbbbbbbbbbbbso.",
                ".Olbbbbbbbbbbbsso.",
                ".obbbbbbbbbbbbsso.",
                ".obbbbbbbbbbbbsso.",
                "..obbbbbbbbbssso..",
                ".Oobbbbbbbsssssoo.",
                "Olbo..........osbo",
                ".oo............oo.",
            ])
        case .deskFrontWait1: .init(
            anchorX: 9, anchorY: 13, view: .front, headX: 10, headY: 0,
            faceX: 4, faceY: 5, face: "hopeful", blink: "hopeful_blink", rows: [
                ".......OOOOOo.....",
                ".....OOlllllboo...",
                "....Olhhlllllbbo..",
                "...Olhlllllllbbbo.",
                "...Ollllllllbbbbo.",
                "..Ollllllbbbbbbbso",
                "..Olllbbbbbbbbbbso",
                "..Ollbbbbbbbbbbbso",
                "..Olbbbbbbbbbbbsso",
                "..obbbbbbbbbbbbsso",
                "..obbbbbbbbbbbbsso",
                "...obbbbbbbbbssso.",
                ".Ooobbbbbbbssssoo.",
                "Olbo..........osbo",
                ".oo............oo.",
            ])
        case .deskFrontBlocked0: .init(
            anchorX: 11, anchorY: 13, view: .front, headX: 11, headY: 0,
            faceX: 5, faceY: 5, face: "urgent", blink: nil, rows: [
                ".Oo.....OOOOOo......",
                "Olbo..OOlllllboo....",
                "Olbo.Olhhlllllbbo...",
                "obboOlhlllllllbbbo..",
                "obsoOllllllllbbbbo..",
                ".obbllllllbbbbbbbso.",
                "..oblllbbbbbbbbbbso.",
                "...Ollbbbbbbbbbbbso.",
                "...Olbbbbbbbbbbbsso.",
                "...obbbbbbbbbbbbsso.",
                "...obbbbbbbbbbbbsso.",
                "....obbbbbbbbbssso..",
                "....obbbbbbbsssssoo.",
                "................osbo",
                ".................oo.",
            ])
        case .deskFrontBlocked1: .init(
            anchorX: 11, anchorY: 15, view: .front, headX: 11, headY: 1,
            faceX: 5, faceY: 6, face: "urgent", blink: nil, rows: [
                ".Oo.................",
                "Olbo....OOOOOo......",
                "Olbo..OOlllllboo....",
                "obbo.Olhhlllllbbo...",
                "obsoOlhlllllllbbbo..",
                ".oboOllllllllbbbbo..",
                ".obbllllllbbbbbbbso.",
                "..oblllbbbbbbbbbbso.",
                "...Ollbbbbbbbbbbbso.",
                "...Olbbbbbbbbbbbsso.",
                "...obbbbbbbbbbbbsso.",
                "...obbbbbbbbbbbbsso.",
                "....obbbbbbbbbssso..",
                "....obbbbbbbssssso..",
                ".....oossssssssoooo.",
                "................osbo",
                ".................oo.",
            ])
        case .deskFrontError: .init(
            anchorX: 11, anchorY: 10, view: .front, headX: 11, headY: 0,
            faceX: 5, faceY: 4, face: "dizzy", blink: nil, rows: [
                "........OOOOOo........",
                ".....OOOlllllbOoo.....",
                "....Olhhlllllllbbo....",
                "...Olhllllllllbbbbo...",
                "..Ollllllllbbbbbbbso..",
                "..Olllllbbbbbbbbbbso..",
                "..Ollbbbbbbbbbbbbbso..",
                ".OOlbbbbbbbbbbbbbssoo.",
                "Olbbbbbbbbbbbbbbbsssbo",
                "obbobbbbbbbbbsssssosso",
                ".oo.oossssssssssoo.oo.",
                "......oooooooooo......",
            ])
        case .deskBackType0: .init(
            anchorX: 9, anchorY: 16, view: .back, headX: 9, headY: 0,
            faceX: 3, faceY: 5, face: nil, blink: nil, rows: [
                "......OOOOOo......",
                "....OOlllllboo....",
                "...Olhhllllbbbo...",
                "...Olhlllllbbbo...",
                "..Olllllllbbbbso..",
                "..Ollllllbbbbbso..",
                "..Ollllbbbbbbbso..",
                "..Ollbbbbbbbbbso..",
                ".OOlbbbbbbbbbssoo.",
                "Olbbbbbbbbbbbsssbo",
                "obbbbbbbbbbbbsssso",
                ".oobbbbbbbbbsssoo.",
                "...obbbbbbbssso...",
                "...obbbbbbsssso...",
                "....oossssssoo....",
                "......oooooo......",
            ])
        case .deskBackType1: .init(
            anchorX: 9, anchorY: 16, view: .back, headX: 9, headY: 0,
            faceX: 3, faceY: 5, face: nil, blink: nil, rows: [
                "......OOOOOo......",
                "....OOlllllboo....",
                "...Olhhllllbbbo...",
                "...Olhlllllbbbo...",
                "..Olllllllbbbbso..",
                "..Ollllllbbbbbso..",
                "..Ollllbbbbbbbso..",
                ".OOllbbbbbbbbbso..",
                "Olblbbbbbbbbbssoo.",
                "obbbbbbbbbbbbsssbo",
                ".oobbbbbbbbbbsssso",
                "..obbbbbbbbbsssoo.",
                "...obbbbbbbssso...",
                "...obbbbbbsssso...",
                "....oossssssoo....",
                "......oooooo......",
            ])
        case .deskBackType2: .init(
            anchorX: 9, anchorY: 16, view: .back, headX: 9, headY: 0,
            faceX: 3, faceY: 5, face: nil, blink: nil, rows: [
                "......OOOOOo......",
                "....OOlllllboo....",
                "...Olhhllllbbbo...",
                "...Olhlllllbbbo...",
                "..Olllllllbbbbso..",
                "..Ollllllbbbbbso..",
                "..Ollllbbbbbbbso..",
                "..Ollbbbbbbbbbsoo.",
                ".OOlbbbbbbbbbsssbo",
                "Olbbbbbbbbbbbsssso",
                "obbbbbbbbbbbbssoo.",
                ".oobbbbbbbbbssso..",
                "...obbbbbbbssso...",
                "...obbbbbbsssso...",
                "....oossssssoo....",
                "......oooooo......",
            ])
        case .deskBackError: .init(
            anchorX: 11, anchorY: 13, view: .back, headX: 11, headY: 0,
            faceX: 5, faceY: 4, face: nil, blink: nil, rows: [
                "........OOOOOo........",
                ".....OOOlllllbOoo.....",
                "....Olhhlllllllbbo....",
                ".OoOlhllllllllbbbbooo.",
                "Olbllllllllbbbbbbbssbo",
                "obblllllbbbbbbbbbbssso",
                ".oOllbbbbbbbbbbbbbsoo.",
                "..Olbbbbbbbbbbbbbsso..",
                "..obbbbbbbbbbbbbbsso..",
                "...obbbbbbbbbssssso...",
                "....oossssssssssoo....",
                "......oooooooooo......",
            ])
        case .chairWait0: .init(
            anchorX: 10, anchorY: 15, view: .front, headX: 10, headY: 0,
            faceX: 4, faceY: 5, face: "hopeful", blink: "hopeful_blink", rows: [
                ".......OOOOOo.......",
                ".....OOlllllboo.....",
                "....Olhhlllllbbo....",
                "...Olhlllllllbbbo...",
                "...Ollllllllbbbbo...",
                "..Ollllllbbbbbbbso..",
                "..Olllbbbbbbbbbbso..",
                "..Ollbbbbbbbbbbbso..",
                "..Olbbbbbbbbbbbsso..",
                ".Oobbbbbbbbbbbbssoo.",
                "Olbbbbbbbbbbbbbsssbo",
                "obbobbbbbbbbbsssosso",
                ".ooobbbbbbbsssssooo.",
                "....oossssssssoo....",
                "......oooooooo......",
            ])
        case .chairWait1: .init(
            anchorX: 9, anchorY: 15, view: .front, headX: 10, headY: 0,
            faceX: 4, faceY: 5, face: "hopeful", blink: "hopeful_blink", rows: [
                ".......OOOOOo.......",
                ".....OOlllllboo.....",
                "....Olhhlllllbbo....",
                "...Olhlllllllbbbo...",
                "...Ollllllllbbbbo...",
                "..Ollllllbbbbbbbso..",
                "..Olllbbbbbbbbbbso..",
                "..Ollbbbbbbbbbbbso..",
                "..Olbbbbbbbbbbbsso..",
                ".Oobbbbbbbbbbbbssoo.",
                "Olbbbbbbbbbbbbbsssbo",
                "obbobbbbbbbbbsssosso",
                ".ooobbbbbbbsssssooo.",
                "....oossssssssoo....",
                "......oooooooo......",
            ])
        case .chairBlocked0: .init(
            anchorX: 11, anchorY: 15, view: .front, headX: 11, headY: 0,
            faceX: 5, faceY: 5, face: "urgent", blink: nil, rows: [
                ".Oo.....OOOOOo.......",
                "Olbo..OOlllllboo.....",
                "Olbo.Olhhlllllbbo....",
                "obboOlhlllllllbbbo...",
                "obsoOllllllllbbbbo...",
                ".obbllllllbbbbbbbso..",
                "..oblllbbbbbbbbbbso..",
                "...Ollbbbbbbbbbbbso..",
                "...Olbbbbbbbbbbbsso..",
                "...obbbbbbbbbbbbssoo.",
                "...obbbbbbbbbbbbsssbo",
                "....obbbbbbbbbsssosso",
                "....obbbbbbbsssssooo.",
                ".....oossssssssoo....",
                ".......oooooooo......",
            ])
        case .chairBlocked1: .init(
            anchorX: 11, anchorY: 17, view: .front, headX: 11, headY: 1,
            faceX: 5, faceY: 6, face: "urgent", blink: nil, rows: [
                ".Oo..................",
                "Olbo....OOOOOo.......",
                "Olbo..OOlllllboo.....",
                "obbo.Olhhlllllbbo....",
                "obsoOlhlllllllbbbo...",
                ".oboOllllllllbbbbo...",
                ".obbllllllbbbbbbbso..",
                "..oblllbbbbbbbbbbso..",
                "...Ollbbbbbbbbbbbso..",
                "...Olbbbbbbbbbbbsso..",
                "...obbbbbbbbbbbbssoo.",
                "...obbbbbbbbbbbbsssbo",
                "....obbbbbbbbbsssosso",
                "....obbbbbbbsssssooo.",
                ".....oossssssssoo....",
                ".......oooooooo......",
            ])
        // Resting at the desk (쉬는 중): paws folded on the desk, content, breathing a pixel.
        case .deskFrontRest0: .init(
            anchorX: 9, anchorY: 13, view: .front, headX: 9, headY: 0,
            faceX: 3, faceY: 5, face: "content", blink: nil, rows: [
                "......OOOOOo......",
                "....OOlllllboo....",
                "...Olhhlllllbbo...",
                "..Olhlllllllbbbo..",
                "..Ollllllllbbbbo..",
                ".Ollllllbbbbbbbso.",
                ".Olllbbbbbbbbbbso.",
                ".Ollbbbbbbbbbbbso.",
                ".Olbbbbbbbbbbbsso.",
                ".obbbbbbbbbbbbsso.",
                ".obbbbbbbbbbbbsso.",
                "..obbbbbbbbbssso..",
                ".Oobbbbbbbsssssoo.",
                "Olbo..........osbo",
                ".oo............oo.",
            ])
        case .deskFrontRest1: .init(
            anchorX: 9, anchorY: 12, view: .front, headX: 9, headY: 0,
            faceX: 3, faceY: 5, face: "content", blink: nil, rows: [
                "......OOOOOo......",
                "....OOlllllboo....",
                "...Olhhlllllbbo...",
                "..Olhlllllllbbbo..",
                "..Ollllllllbbbbo..",
                ".Ollllllbbbbbbbso.",
                ".Olllbbbbbbbbbbso.",
                ".Ollbbbbbbbbbbbso.",
                ".Olbbbbbbbbbbbsso.",
                ".obbbbbbbbbbbbsso.",
                ".obbbbbbbbbbbbsso.",
                ".Oobbbbbbbsssssoo.",
                "Olbo..........osbo",
                ".oo............oo.",
            ])
        // Asleep at the desk (잠듦): slumped forward onto it, cheek on the paws, nodding a pixel.
        case .deskFrontSleep0: .init(
            anchorX: 11, anchorY: 10, view: .front, headX: 11, headY: 0,
            faceX: 5, faceY: 5, face: "sleep", blink: nil, rows: [
                "........OOOOOo........",
                "......OOlllllboo......",
                ".....Olhhllllbbbo.....",
                "....Olhlllllllbbbo....",
                "....Ollllllllbbbbo....",
                "...Olllllllbbbbbbso...",
                "...Ollllbbbbbbbbbso...",
                "...Ollbbbbbbbbbbbso...",
                ".Oobbbbbbbbbbbbbbssoo.",
                "Olbbbbbbbbbbbbbbbsssbo",
                "obbbbbbbbbbbbbbbssssso",
                ".oosbbbbbbbbbbsssssoo.",
                "...oooooooooooooooo...",
            ])
        case .deskFrontSleep1: .init(
            anchorX: 11, anchorY: 9, view: .front, headX: 11, headY: 0,
            faceX: 5, faceY: 4, face: "sleep", blink: nil, rows: [
                "........OOOOOo........",
                "......OOlllllboo......",
                ".....Olhhllllbbbo.....",
                "....Olhlllllllbbbo....",
                "...Olllllllbbbbbbso...",
                "...Ollllbbbbbbbbbso...",
                "...Ollbbbbbbbbbbbso...",
                ".Oobbbbbbbbbbbbbbssoo.",
                "Olbbbbbbbbbbbbbbbsssbo",
                "obbbbbbbbbbbbbbbssssso",
                ".oosbbbbbbbbbbsssssoo.",
                "...oooooooooooooooo...",
            ])
        // Resting at the desk seen from behind: still paws, breathing a pixel.
        case .deskBackRest0: .init(
            anchorX: 9, anchorY: 16, view: .back, headX: 9, headY: 0,
            faceX: 3, faceY: 5, face: nil, blink: nil, rows: [
                "......OOOOOo......",
                "....OOlllllboo....",
                "...Olhhllllbbbo...",
                "...Olhlllllbbbo...",
                "..Olllllllbbbbso..",
                "..Ollllllbbbbbso..",
                "..Ollllbbbbbbbso..",
                "..Ollbbbbbbbbbso..",
                ".OOlbbbbbbbbbssoo.",
                "Olbbbbbbbbbbbsssbo",
                "obbbbbbbbbbbbsssso",
                ".oobbbbbbbbbsssoo.",
                "...obbbbbbbssso...",
                "...obbbbbbsssso...",
                "....oossssssoo....",
                "......oooooo......",
            ])
        case .deskBackRest1: .init(
            anchorX: 9, anchorY: 15, view: .back, headX: 9, headY: 0,
            faceX: 3, faceY: 5, face: nil, blink: nil, rows: [
                "......OOOOOo......",
                "....OOlllllboo....",
                "...Olhhllllbbbo...",
                "...Olhlllllbbbo...",
                "..Olllllllbbbbso..",
                "..Ollllllbbbbbso..",
                "..Ollbbbbbbbbbso..",
                ".OOlbbbbbbbbbssoo.",
                "Olbbbbbbbbbbbsssbo",
                "obbbbbbbbbbbbsssso",
                ".oobbbbbbbbbsssoo.",
                "...obbbbbbbssso...",
                "...obbbbbbsssso...",
                "....oossssssoo....",
                "......oooooo......",
            ])
        // Asleep at the desk seen from behind: head bowed onto the desk (the body squashed down), nodding a pixel.
        case .deskBackSleep0: .init(
            anchorX: 9, anchorY: 14, view: .back, headX: 9, headY: 0,
            faceX: 3, faceY: 5, face: nil, blink: nil, rows: [
                "......OOOOOo......",
                "....OOlllllboo....",
                "...Olhhllllbbbo...",
                "..Olllllllbbbbso..",
                "..Ollllbbbbbbbso..",
                "..Ollbbbbbbbbbso..",
                ".OOlbbbbbbbbbssoo.",
                "Olbbbbbbbbbbbsssbo",
                "obbbbbbbbbbbbsssso",
                ".oobbbbbbbbbsssoo.",
                "...obbbbbbbssso...",
                "...obbbbbbsssso...",
                "....oossssssoo....",
                "......oooooo......",
            ])
        case .deskBackSleep1: .init(
            anchorX: 9, anchorY: 13, view: .back, headX: 9, headY: 0,
            faceX: 3, faceY: 5, face: nil, blink: nil, rows: [
                "......OOOOOo......",
                "....OOlllllboo....",
                "...Olhhllllbbbo...",
                "..Olllllllbbbbso..",
                "..Ollbbbbbbbbbso..",
                ".OOlbbbbbbbbbssoo.",
                "Olbbbbbbbbbbbsssbo",
                "obbbbbbbbbbbbsssso",
                ".oobbbbbbbbbsssoo.",
                "...obbbbbbbssso...",
                "...obbbbbbsssso...",
                "....oossssssoo....",
                "......oooooo......",
            ])
        }
    }
}
