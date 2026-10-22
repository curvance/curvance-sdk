import { Contract } from "ethers";
import { WAD_DECIMAL, type ChainRpcPrefix } from "../helpers";
import type { SetupConfigSnapshot } from "../setup";
import { address, curvance_read_provider, curvance_signer } from "../types";
import { OptimizerReader } from "./OptimizerReader";
import optimizer_abi from '../abis/LendingOptimizer.json';
import { ERC20 } from "./ERC20";
import { OracleManager } from "./OracleManager";
import Decimal from "decimal.js";

export interface IOptimizer {
    exchangeRate(): Promise<bigint>;
    asset(): Promise<address>;
    totalSupply(): Promise<bigint>;
}

export class Optimizer {
    address: address;
    provider: curvance_read_provider;
    signer: curvance_signer | null;
    name: string;
    chain: ChainRpcPrefix;
    reader: OptimizerReader;
    contract: Contract & IOptimizer;
    oracle_manager: OracleManager;

    constructor(
        address: address,
        signer: curvance_signer | null,
        reader: OptimizerReader,
        name: string,
        chain: ChainRpcPrefix,
        oracle_manager: OracleManager,
    ) {
        this.address = address;
        this.provider = reader.provider;
        this.signer = signer;
        this.name = name;
        this.chain = chain;
        this.reader = reader;
        this.oracle_manager = oracle_manager;
        this.contract = new Contract(address, optimizer_abi, signer ?? this.provider) as Contract & IOptimizer;
    }

    async getAsset(): Promise<ERC20> {
        const asset_address = await this.contract.asset();
        return new ERC20(
            this.provider,
            asset_address,
            undefined,
            this.oracle_manager.address,
            this.signer,
        );
    }

    async getPrice(): Promise<Decimal> {
        const asset = await this.getAsset();
        const price = await this.oracle_manager.getPrice(asset.address, true, false);
        const rate = await this.contract.exchangeRate();

        return Decimal(price.toString()).mul(rate.toString()).div(WAD_DECIMAL).div(WAD_DECIMAL);
    }

    async getDeposits() {
        const price = await this.getPrice();
        const total_supply = await this.contract.totalSupply();
        const asset = await this.getAsset();
        const decimals = await asset.fetchDecimals();
        const normalized_supply = Decimal(total_supply.toString()).div(Decimal(10).pow(decimals));
        return normalized_supply.mul(price);
    }

    async getApy() {
        return this.reader.getOptimizerAPY(this.address);
    }

    static getAll(setup?: SetupConfigSnapshot, oracle_manager?: OracleManager): Optimizer[] {
        const resolvedSetup = setup ?? Optimizer.getSetupConfig();
        if (resolvedSetup == undefined) {
            throw new Error(
                "Setup config is not configured for Optimizer.getAll. " +
                "Pass setup context explicitly or initialize setupChain() first."
            );
        }

        const contracts = resolvedSetup.contracts as {
            OracleManager?: address;
            OptimizerReader?: address;
            Optimizers?: Record<string, address>;
        };
        const optimizers = contracts.Optimizers ?? {};
        const optimizerEntries = Object.entries(optimizers);

        if (optimizerEntries.length === 0) {
            return [];
        }

        if (contracts.OptimizerReader == undefined) {
            throw new Error(`Chain configuration for ${resolvedSetup.chain} is missing OptimizerReader address.`);
        }
        if (contracts.OracleManager == undefined) {
            throw new Error(`Chain configuration for ${resolvedSetup.chain} is missing OracleManager address.`);
        }

        const reader = new OptimizerReader(contracts.OptimizerReader, resolvedSetup.readProvider);
        const resolvedOracleManager = oracle_manager ?? new OracleManager(contracts.OracleManager, resolvedSetup.readProvider);

        return optimizerEntries.map(([name, optimizerAddress]) => (
            new Optimizer(
                optimizerAddress,
                resolvedSetup.signer,
                reader,
                name,
                resolvedSetup.chain,
                resolvedOracleManager,
            )
        ));
    }

    private static getSetupConfig(): SetupConfigSnapshot | undefined {
        return (require("../setup") as typeof import("../setup")).setup_config;
    }
}
