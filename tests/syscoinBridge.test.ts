import assert from "node:assert/strict";

import { concatHex, encodeAbiParameters, toEventSelector, toFunctionSelector } from "viem";
import { describe, it } from "vitest";

import { getSyscoinTanenbaumFaucetUrl, SYSCOIN_TANENBAUM_FAUCET_URL } from "../data/syscoin";
import {
  SYSCOIN_DEFAULT_L1_ERC20_DEPOSIT_GAS_LIMIT,
  SYSCOIN_DEFAULT_L2_PRIORITY_FEE,
  SYSCOIN_DEFAULT_L2_TRANSFER_GAS_LIMIT,
  SYSCOIN_DEFAULT_L2_GAS_LIMIT,
  SYSCOIN_REQUIRED_L1_TO_L2_GAS_PER_PUBDATA_BYTE,
  buildSyscoinErc20DepositRequest,
  buildSyscoinErc20SecondBridgeCalldata,
  buildSyscoinErc20TransferData,
  buildSyscoinErc20WithdrawData,
  buildSyscoinGatewayMigrationTransaction,
  buildSyscoinL2BaseTokenWithdrawData,
  buildSyscoinNativeTokenWithdrawTransaction,
  buildSyscoinTsysDepositRequest,
  buildSyscoinTransferTransaction,
  buildSyscoinWithdrawTransaction,
  encodeSyscoinErc20Deposit,
  encodeSyscoinTsysDeposit,
  getSyscoinFinalizeWithdrawalParams,
  getSyscoinGatewayMigrationFinalizeParams,
  getSyscoinL2FeeOverrides,
  getSyscoinWithdrawalFeeEstimationAmount,
  parseSyscoinAssetRouterWithdrawalMessage,
  parseSyscoinBaseTokenWithdrawalMessage,
} from "../utils/syscoinBridge";

const chainId = 57_057n;
const sharedBridge = "0xc769c7b29543393f2e2cb209a07721b62cdd94fa";
const l1Token = "0x1111111111111111111111111111111111111111";
const l2Token = "0x2222222222222222222222222222222222222222";
const receiver = "0x3333333333333333333333333333333333333333";
const amount = 1_000_000_000_000_000_000n;
const baseCost = 42_000_000_000_000n;
const assetId = "0xaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa";

describe("syscoin bridge encoding", () => {
  it("uses a non-zero probe to estimate an empty withdrawal form without changing real amounts", () => {
    assert.equal(getSyscoinWithdrawalFeeEstimationAmount(0n), 1n);
    assert.equal(getSyscoinWithdrawalFeeEstimationAmount(amount), amount);
  });

  it("prefills the Tanenbaum faucet only for valid wallet addresses", () => {
    assert.equal(getSyscoinTanenbaumFaucetUrl(), SYSCOIN_TANENBAUM_FAUCET_URL);
    assert.equal(getSyscoinTanenbaumFaucetUrl("undefined"), SYSCOIN_TANENBAUM_FAUCET_URL);
    assert.equal(getSyscoinTanenbaumFaucetUrl(receiver), `${SYSCOIN_TANENBAUM_FAUCET_URL}/?address=${receiver}`);
  });

  it("keeps ERC20 deposit L1 gas limit above observed two-bridge cost", () => {
    assert.equal(SYSCOIN_DEFAULT_L1_ERC20_DEPOSIT_GAS_LIMIT, 1_300_000n);
  });

  it("keeps account transfer gas floor above observed Tanenbaum estimate", () => {
    assert.equal(SYSCOIN_DEFAULT_L2_TRANSFER_GAS_LIMIT, 65_000n);
  });

  it("caps Syscoin L2 priority fee below the max fee", () => {
    assert.deepEqual(
      getSyscoinL2FeeOverrides({
        baseFeePerGas: 375_000_000_000n,
        suggestedMaxFeePerGas: 562_500_000_000n,
      }),
      {
        maxFeePerGas: 562_500_000_000n,
        maxPriorityFeePerGas: SYSCOIN_DEFAULT_L2_PRIORITY_FEE,
      }
    );
    assert.deepEqual(
      getSyscoinL2FeeOverrides({
        baseFeePerGas: 375_000_000_000n,
        suggestedMaxFeePerGas: 376_000_000_000n,
      }),
      {
        maxFeePerGas: 380_000_000_000n,
        maxPriorityFeePerGas: SYSCOIN_DEFAULT_L2_PRIORITY_FEE,
      }
    );
    assert.deepEqual(
      getSyscoinL2FeeOverrides({
        baseFeePerGas: 0n,
        suggestedMaxFeePerGas: 1_000_000_000n,
      }),
      {
        maxFeePerGas: SYSCOIN_DEFAULT_L2_PRIORITY_FEE,
        maxPriorityFeePerGas: SYSCOIN_DEFAULT_L2_PRIORITY_FEE,
      }
    );
    assert.deepEqual(
      getSyscoinL2FeeOverrides({
        baseFeePerGas: undefined,
        suggestedMaxFeePerGas: 562_500_000_000n,
      }),
      {
        maxFeePerGas: 562_500_000_000n,
        maxPriorityFeePerGas: SYSCOIN_DEFAULT_L2_PRIORITY_FEE,
      }
    );
    assert.deepEqual(
      getSyscoinL2FeeOverrides({
        baseFeePerGas: undefined,
        suggestedMaxFeePerGas: 1_000_000_000n,
      }),
      {
        maxFeePerGas: SYSCOIN_DEFAULT_L2_PRIORITY_FEE,
        maxPriorityFeePerGas: SYSCOIN_DEFAULT_L2_PRIORITY_FEE,
      }
    );
  });

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

  it("keeps legacy ERC20 deposit data for an unregistered L1 token", () => {
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

  it("builds v31 asset-id deposit data for a registered token", () => {
    const transferData = encodeAbiParameters(
      [{ type: "uint256" }, { type: "address" }, { type: "address" }],
      [amount, receiver, l1Token]
    );
    const expectedCalldata = concatHex([
      "0x01",
      encodeAbiParameters([{ type: "bytes32" }, { type: "bytes" }], [assetId, transferData]),
    ]);

    assert.equal(buildSyscoinErc20SecondBridgeCalldata(l1Token, amount, receiver, assetId), expectedCalldata);

    const request = buildSyscoinErc20DepositRequest({
      chainId,
      l1Token,
      amount,
      l2Receiver: receiver,
      baseCost,
      sharedBridgeAddress: sharedBridge,
      assetId,
    });
    assert.equal(request.secondBridgeCalldata, expectedCalldata);
  });

  it("builds L2 withdrawal calldata for TSYS and ERC20", () => {
    assert.equal(buildSyscoinL2BaseTokenWithdrawData(receiver).slice(0, 10), toFunctionSelector("withdraw(address)"));
    assert.equal(
      buildSyscoinErc20WithdrawData({
        assetId,
        l1Receiver: receiver,
        l2Token,
        amount,
      }).slice(0, 10),
      toFunctionSelector("withdraw(bytes32,bytes)")
    );
  });

  it("builds standard EVM transfers for TSYS and ERC20", () => {
    assert.equal(
      buildSyscoinErc20TransferData(receiver, amount).slice(0, 10),
      toFunctionSelector("transfer(address,uint256)")
    );

    const baseTokenTx = buildSyscoinTransferTransaction({
      recipient: receiver,
      l2Token: "0x000000000000000000000000000000000000800A",
      amount,
    });
    assert.equal(baseTokenTx.to, receiver);
    assert.equal(baseTokenTx.value, amount);
    assert.equal(baseTokenTx.data, undefined);

    const erc20Tx = buildSyscoinTransferTransaction({
      recipient: receiver,
      l2Token,
      amount,
    });
    assert.equal(erc20Tx.to, l2Token);
    assert.equal(erc20Tx.value, 0n);
    assert.equal(erc20Tx.data?.slice(0, 10), toFunctionSelector("transfer(address,uint256)"));
  });

  it("builds matching Syscoin withdrawal transaction requests", () => {
    const baseTokenTx = buildSyscoinWithdrawTransaction({
      l1Receiver: receiver,
      l2Token: "0x000000000000000000000000000000000000800a",
      amount,
    });
    assert.equal(baseTokenTx.to, "0x000000000000000000000000000000000000800a");
    assert.equal(baseTokenTx.value, amount);
    assert.equal(baseTokenTx.data.slice(0, 10), toFunctionSelector("withdraw(address)"));

    const erc20Tx = buildSyscoinWithdrawTransaction({
      assetId,
      l1Receiver: receiver,
      l2Token,
      amount,
    });
    assert.equal(erc20Tx.to, "0x0000000000000000000000000000000000010003");
    assert.equal(erc20Tx.value, 0n);
    assert.equal(erc20Tx.data.slice(0, 10), toFunctionSelector("withdraw(bytes32,bytes)"));
    assert.ok(erc20Tx.data.includes(assetId.slice(2)));
  });

  it("builds native Syscoin token withdrawal transaction requests", () => {
    const nativeTokenTx = buildSyscoinNativeTokenWithdrawTransaction({
      assetId,
      l1Receiver: receiver,
      l2Token,
      amount,
    });

    assert.equal(nativeTokenTx.to, "0x0000000000000000000000000000000000010003");
    assert.equal(nativeTokenTx.value, 0n);
    assert.equal(nativeTokenTx.data.slice(0, 10), toFunctionSelector("withdraw(bytes32,bytes)"));
    assert.ok(nativeTokenTx.data.includes(assetId.slice(2)));
  });

  it("builds Gateway migration transaction requests", () => {
    const migrationTx = buildSyscoinGatewayMigrationTransaction(assetId);

    assert.equal(migrationTx.to, "0x000000000000000000000000000000000001000f");
    assert.equal(migrationTx.value, 0n);
    assert.equal(migrationTx.data.slice(0, 10), toFunctionSelector("initiateL1ToGatewayMigrationOnL2(bytes32)"));
    assert.ok(migrationTx.data.includes(assetId.slice(2)));
  });

  it("derives OS withdrawal finalization params from receipt and log proof", async () => {
    const withdrawalHash = "0xeb2ed53ace69581b2ea88d5cbd850e5b9a0bb897b521c4feda88a50de4d2f30b";
    const message =
      "0x6c0960f9ec2613bd64d860b654d30af8b1fd83fe9cf3e0070000000000000000000000000000000000000000000000008ac7230489e80000";
    const messageHash = "0x8093dca118cb16c0f80e076e505980cfef061dd3425464fe0f28c98dc6142fd4";
    const proof = ["0x1111111111111111111111111111111111111111111111111111111111111111"];
    let requestedProofIndex: number | undefined;
    const provider = {
      send: async (method: string, params?: unknown[]) => {
        if (method === "eth_getTransactionReceipt") {
          return {
            transactionIndex: "0x3",
            logs: [
              {
                address: "0x0000000000000000000000000000000000008008",
                topics: [
                  toEventSelector("L1MessageSent(address,bytes32,bytes)"),
                  "0x000000000000000000000000000000000000000000000000000000000000800a",
                  messageHash,
                ],
                data: encodeAbiParameters([{ type: "bytes" }], [message]),
              },
            ],
            l2ToL1Logs: [
              {
                sender: "0x0000000000000000000000000000000000008008",
                key: "0x000000000000000000000000000000000000000000000000000000000000800a",
                value: "0xffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffff",
              },
              {
                sender: "0x0000000000000000000000000000000000008008",
                key: "0x000000000000000000000000000000000000000000000000000000000000800a",
                value: messageHash,
              },
            ],
          };
        }
        if (method === "zks_getL2ToL1LogProof") {
          requestedProofIndex = params?.[1] as number;
          return { batchNumber: 42, id: 7, proof };
        }
        throw new Error(`Unexpected RPC method: ${method}`);
      },
    };

    const params = await getSyscoinFinalizeWithdrawalParams(provider, withdrawalHash, chainId);

    assert.equal(requestedProofIndex, 1);
    assert.equal(params.chainId, chainId);
    assert.equal(params.l2BatchNumber, 42n);
    assert.equal(params.l2MessageIndex, 7n);
    assert.equal(params.l2Sender, "0x000000000000000000000000000000000000800A");
    assert.equal(params.l2TxNumberInBatch, 3);
    assert.equal(params.message, message);
    assert.deepEqual(params.merkleProof, proof);
  });

  it("requests L1-batch-root proofs for Gateway migration finalization", async () => {
    const migrationHash = "0xafa6aa8817de22657391adcabfad1b850fb318ddc9477441a7ee6ce6d1fe0f61";
    const message =
      "0xe288a86801000000000000000000000000000000000000000000000000000000000000000000000000000000000000006ebb170f69d886916d9ee9e585ce39e626cbc35d000000000000000000000000000000000000000000000000000000000000dee1";
    const messageHash = "0x2543674ae90cf0ebb96202a9e76cc62288f34f52ca1de0200353c40604b61e5d";
    const proof = ["0x2222222222222222222222222222222222222222222222222222222222222222"];
    let requestedProofParams: unknown[] | undefined;
    const provider = {
      send: async (method: string, params?: unknown[]) => {
        if (method === "eth_getTransactionReceipt") {
          return {
            transactionIndex: "0x0",
            logs: [
              {
                address: "0x0000000000000000000000000000000000008008",
                topics: [
                  toEventSelector("L1MessageSent(address,bytes32,bytes)"),
                  "0x000000000000000000000000000000000000000000000000000000000001000f",
                  messageHash,
                ],
                data: encodeAbiParameters([{ type: "bytes" }], [message]),
              },
            ],
            l2ToL1Logs: [
              {
                sender: "0x0000000000000000000000000000000000008008",
                key: "0x000000000000000000000000000000000000000000000000000000000001000f",
                value: messageHash,
              },
            ],
          };
        }
        if (method === "zks_getL2ToL1LogProof") {
          requestedProofParams = params;
          return { batchNumber: 1930, id: 0, proof };
        }
        throw new Error(`Unexpected RPC method: ${method}`);
      },
    };

    const params = await getSyscoinGatewayMigrationFinalizeParams(provider, migrationHash, chainId);

    assert.deepEqual(requestedProofParams, [migrationHash, 0]);
    assert.equal(params.l2BatchNumber, 1930n);
    assert.equal(params.l2Sender, "0x000000000000000000000000000000000001000f");
    assert.equal(params.message, message);
  });

  it("parses packed base-token withdrawal messages", () => {
    const message = `0x6c0960f9${receiver.slice(2)}${amount.toString(16).padStart(64, "0")}` as `0x${string}`;

    const parsed = parseSyscoinBaseTokenWithdrawalMessage(message);

    assert.equal(parsed.l1Receiver, receiver);
    assert.equal(parsed.amount, amount);
  });

  it.each([
    ["legacy recovery format", "0x6c0960f9"],
    ["v31 finalizeDeposit", "0x9c884fd1"],
  ])("parses asset-router withdrawal messages from the %s", (_, selector) => {
    const originChainId = 57_057n;
    const originalCaller = "0x4444444444444444444444444444444444444444";
    const erc20Metadata = "0x1234";
    const transferData = encodeAbiParameters(
      [{ type: "address" }, { type: "address" }, { type: "address" }, { type: "uint256" }, { type: "bytes" }],
      [originalCaller, receiver, l1Token, amount, erc20Metadata]
    );
    const message = `${selector}${originChainId.toString(16).padStart(64, "0")}${assetId.slice(2)}${transferData.slice(
      2
    )}` as `0x${string}`;

    const parsed = parseSyscoinAssetRouterWithdrawalMessage(message);

    assert.equal(parsed.originChainId, originChainId);
    assert.equal(parsed.assetId, assetId);
    assert.equal(parsed.originalCaller, originalCaller);
    assert.equal(parsed.l1Receiver, receiver);
    assert.equal(parsed.l1Token, l1Token);
    assert.equal(parsed.amount, amount);
    assert.equal(parsed.erc20Metadata, erc20Metadata);
  });
});
