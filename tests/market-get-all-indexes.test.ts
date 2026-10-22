import assert from "node:assert/strict";
import test from "node:test";
import { Market } from "../src/classes/Market";
import { aggregateMerklAprByToken } from "../src/helpers";
import Decimal from "decimal.js";

function assertDecimalString(actual: Decimal | undefined, expected: string, message: string) {
    assert.equal(actual?.toString(), expected, message);
}

test("buildDeployDataIndex rejects duplicate deployment market addresses", () => {
    assert.throws(
        () => (Market as any).buildDeployDataIndex({
            contracts: {
                markets: {
                    first: {
                        address: "0x00000000000000000000000000000000000000a1",
                        plugins: { simplePositionManager: "0x0000000000000000000000000000000000000001" },
                    },
                    second: {
                        address: "0x00000000000000000000000000000000000000A1",
                        plugins: { simplePositionManager: "0x0000000000000000000000000000000000000002" },
                    },
                    ignoredPrimitive: "0xdef",
                    ignoredNull: null,
                },
            },
        }),
        /Duplicate deployment market address/i,
    );
});

test("aggregateMerklAprByToken sums duplicate opportunities by the shared matching policy", () => {
    const depositApy = aggregateMerklAprByToken([
        {
            identifier: "lend-campaign-1",
            apr: 12,
            tokens: [{ address: "0xAbC" }],
        },
        {
            identifier: "lend-campaign-2",
            apr: 34,
            tokens: [{ address: "0xaBc" }],
        },
    ], "deposit");
    const borrowApy = aggregateMerklAprByToken([
        {
            identifier: "0xAbC",
            apr: 5,
            tokens: [],
        },
        {
            identifier: "0xaBc",
            apr: 7,
            tokens: [{ address: "0xdef" }],
        },
    ], "borrow");

    assert.equal(depositApy.size, 1);
    assertDecimalString(depositApy.get("0xabc"), "0.46", "deposit APY should sum duplicate token membership rows");
    assert.equal(borrowApy.size, 1);
    assertDecimalString(borrowApy.get("0xabc"), "0.12", "borrow APY should sum identifier and membership matches");
});

test("buildYieldIndex rejects duplicate legacy symbol-only yields", () => {
    assert.throws(
        () => (Market as any).buildYieldIndex([
            { symbol: "ausd", apy: 1.23 },
            { symbol: "AUSD", apy: 4.56 },
        ]),
        /Duplicate native-yield symbol AUSD/i,
    );
});

test("buildYieldIndex separates same-symbol yields by cToken address", () => {
    const index = (Market as any).buildYieldIndex([
        { symbol: 'AUSD', token: '0x00000000000000000000000000000000000000AA', apy: 2 },
        { symbol: 'AUSD', token: '0x00000000000000000000000000000000000000BB', apy: 5 },
    ]);
    assert.equal(index.get('0x00000000000000000000000000000000000000aa').apy, 2);
    assert.equal(index.get('0x00000000000000000000000000000000000000bb').apy, 5);
    assert.equal(index.has('AUSD'), false);
});
