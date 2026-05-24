import assert from "node:assert/strict";

import { encodeAbiParameters, toFunctionSelector } from "viem";
import { describe, it } from "vitest";

import {
  SYSCOIN_DEFAULT_L2_GAS_LIMIT,
  SYSCOIN_REQUIRED_L1_TO_L2_GAS_PER_PUBDATA_BYTE,
  buildSyscoinErc20DepositRequest,
  buildSyscoinErc20SecondBridgeCalldata,
  buildSyscoinErc20WithdrawData,
  buildSyscoinL2BaseTokenWithdrawData,
  buildSyscoinTsysDepositRequest,
  encodeSyscoinErc20Deposit,
  encodeSyscoinTsysDeposit,
} from "../utils/syscoinBridge";

const chainId = 57_057n;
const sharedBridge = "0xc769c7b29543393f2e2cb209a07721b62cdd94fa";
const l1Token = "0x1111111111111111111111111111111111111111";
const l2Token = "0x2222222222222222222222222222222222222222";
const receiver = "0x3333333333333333333333333333333333333333";
const amount = 1_000_000_000_000_000_000n;
const baseCost = 42_000_000_000_000n;

describe("syscoin bridge encoding", () => {
  it("builds TSYS Bridgehub direct deposit requests", () => {
    const request = buildSyscoinTsysDepositRequest({
      chainId,
      l2Receiver: receiver,
      amount,
      baseCost,
    });

    assert.equal(request.chainId, chainId);
    assert.equal(request.mintValue, baseCost + amount);
    assert.equal(request.l2Contract, receiver);
    assert.equal(request.l2Value, amount);
    assert.equal(request.l2Calldata, "0x");
    assert.equal(request.l2GasLimit, SYSCOIN_DEFAULT_L2_GAS_LIMIT);
    assert.equal(request.l2GasPerPubdataByteLimit, SYSCOIN_REQUIRED_L1_TO_L2_GAS_PER_PUBDATA_BYTE);
    assert.equal(encodeSyscoinTsysDeposit(request).slice(0, 10), "0xd52471c1");
  });

  it("builds ERC20 Bridgehub two-bridge deposit requests", () => {
    const secondBridgeCalldata = buildSyscoinErc20SecondBridgeCalldata(l1Token, amount, receiver);
    assert.equal(
      secondBridgeCalldata,
      encodeAbiParameters([{ type: "address" }, { type: "uint256" }, { type: "address" }], [l1Token, amount, receiver])
    );

    const request = buildSyscoinErc20DepositRequest({
      chainId,
      l1Token,
      amount,
      l2Receiver: receiver,
      baseCost,
      sharedBridgeAddress: sharedBridge,
    });

    assert.equal(request.chainId, chainId);
    assert.equal(request.mintValue, baseCost);
    assert.equal(request.l2Value, 0n);
    assert.equal(request.secondBridgeAddress, sharedBridge);
    assert.equal(request.secondBridgeValue, 0n);
    assert.equal(request.secondBridgeCalldata, secondBridgeCalldata);
    assert.equal(encodeSyscoinErc20Deposit(request).slice(0, 10), "0x24fd57fb");
  });

  it("builds L2 withdrawal calldata for TSYS and ERC20", () => {
    assert.equal(
      buildSyscoinL2BaseTokenWithdrawData(receiver).slice(0, 10),
      toFunctionSelector("withdraw(address)")
    );
    assert.equal(
      buildSyscoinErc20WithdrawData(receiver, l2Token, amount).slice(0, 10),
      toFunctionSelector("withdraw(address,address,uint256)")
    );
  });
});
