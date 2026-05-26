import assert from "node:assert/strict";

import { encodeAbiParameters, toEventSelector, toFunctionSelector } from "viem";
import { describe, it } from "vitest";

import {
  getSyscoinTanenbaumFaucetUrl,
  SYSCOIN_TANENBAUM_FAUCET_URL,
} from "../data/syscoin";
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
  buildSyscoinL2BaseTokenWithdrawData,
  buildSyscoinTsysDepositRequest,
  buildSyscoinTransferTransaction,
  buildSyscoinWithdrawTransaction,
  encodeSyscoinErc20Deposit,
  encodeSyscoinTsysDeposit,
  getSyscoinFinalizeWithdrawalParams,
  getSyscoinL2TransferFeeOverrides,
} from "../utils/syscoinBridge";

const chainId = 57_057n;
const sharedBridge = "0xc769c7b29543393f2e2cb209a07721b62cdd94fa";
const l1Token = "0x1111111111111111111111111111111111111111";
const l2Token = "0x2222222222222222222222222222222222222222";
const receiver = "0x3333333333333333333333333333333333333333";
const amount = 1_000_000_000_000_000_000n;
const baseCost = 42_000_000_000_000n;

describe("syscoin bridge encoding", () => {
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

  it("caps Syscoin transfer priority fee below the max fee", () => {
    assert.deepEqual(
      getSyscoinL2TransferFeeOverrides({
        baseFeePerGas: 375_000_000_000n,
        suggestedMaxFeePerGas: 562_500_000_000n,
      }),
      {
        maxFeePerGas: 562_500_000_000n,
        maxPriorityFeePerGas: SYSCOIN_DEFAULT_L2_PRIORITY_FEE,
      }
    );
    assert.deepEqual(
      getSyscoinL2TransferFeeOverrides({
        baseFeePerGas: 375_000_000_000n,
        suggestedMaxFeePerGas: 376_000_000_000n,
      }),
      {
        maxFeePerGas: 380_000_000_000n,
        maxPriorityFeePerGas: SYSCOIN_DEFAULT_L2_PRIORITY_FEE,
      }
    );
    assert.deepEqual(
      getSyscoinL2TransferFeeOverrides({
        baseFeePerGas: 0n,
        suggestedMaxFeePerGas: 1_000_000_000n,
      }),
      {
        maxFeePerGas: SYSCOIN_DEFAULT_L2_PRIORITY_FEE,
        maxPriorityFeePerGas: SYSCOIN_DEFAULT_L2_PRIORITY_FEE,
      }
    );
    assert.deepEqual(
      getSyscoinL2TransferFeeOverrides({
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
    assert.equal(buildSyscoinL2BaseTokenWithdrawData(receiver).slice(0, 10), toFunctionSelector("withdraw(address)"));
    assert.equal(
      buildSyscoinErc20WithdrawData(receiver, l2Token, amount).slice(0, 10),
      toFunctionSelector("withdraw(address,address,uint256)")
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
      l2Token: "0x000000000000000000000000000000000000800A",
      amount,
    });
    assert.equal(baseTokenTx.to, "0x000000000000000000000000000000000000800A");
    assert.equal(baseTokenTx.value, amount);
    assert.equal(baseTokenTx.data.slice(0, 10), toFunctionSelector("withdraw(address)"));

    const erc20Tx = buildSyscoinWithdrawTransaction({
      l1Receiver: receiver,
      l2Token,
      amount,
    });
    assert.equal(erc20Tx.to, "0x0000000000000000000000000000000000010003");
    assert.equal(erc20Tx.value, 0n);
    assert.equal(erc20Tx.data.slice(0, 10), toFunctionSelector("withdraw(address,address,uint256)"));
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
});
