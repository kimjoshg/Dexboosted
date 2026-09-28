import BN from "bn.js";
import {
  PUMP_SDK,
  OnlinePumpSdk,
  bondingCurvePda,
  canonicalPumpPoolPda,
  creatorVaultPda,
  feeSharingConfigPda,
  isCreatorUsingSharingConfig,
} from "@pump-fun/pump-sdk";
import {
  OnlinePumpAmmSdk,
  coinCreatorVaultAuthorityPda,
  coinCreatorVaultAtaPda,
} from "@pump-fun/pump-swap-sdk";
import { AccountLayout, NATIVE_MINT, TOKEN_PROGRAM_ID } from "@solana/spl-token";
import { Connection, PublicKey } from "@solana/web3.js";

const MINT = "Bhm716jHFgvkdtnYSPNbhoXp66kFs64WV8ga2bjepump";
const RENT = new BN(890880);
const RPC = process.env.SOLANA_RPC_URL || process.env.NEXT_PUBLIC_SOLANA_RPC_URL || "https://api.mainnet-beta.solana.com";

export default async function handler(req, res) {
  const mintText = String(req.query?.mint || MINT);
  if (mintText !== MINT) return res.status(400).json({ error: "Unsupported mint" });

  try {
    const mint = new PublicKey(mintText);
    const connection = new Connection(RPC, "confirmed");
    const onlineSdk = new OnlinePumpSdk(connection);
    const bondingCurveAddress = bondingCurvePda(mint);
    const bondingCurve = await onlineSdk.fetchBondingCurve(mint);

    let isGraduated = false;
    let poolCoinCreator = null;
    let isCashbackCoin = false;
    const poolPda = canonicalPumpPoolPda(mint);
    const poolAccountInfo = await connection.getAccountInfo(poolPda);

    if (poolAccountInfo) {
      isGraduated = true;
      try {
        const amm = new OnlinePumpAmmSdk(connection);
        const pool = await amm.fetchPool(poolPda);
        poolCoinCreator = pool.coinCreator;
        isCashbackCoin = pool.isCashbackCoin === true ||
          (typeof pool.is_cashback_coin === "object" && pool.is_cashback_coin?.[0] === true);
      } catch {}
    } else {
      isCashbackCoin = bondingCurve.isCashbackCoin === true ||
        (typeof bondingCurve.is_cashback_coin === "object" && bondingCurve.is_cashback_coin?.[0] === true);
    }

    const effectiveCreator = poolCoinCreator || new PublicKey(bondingCurve.creator);
    let hasSharingConfig = false;
    if (!isCashbackCoin) {
      hasSharingConfig = isCreatorUsingSharingConfig({ mint, creator: effectiveCreator });
      if (hasSharingConfig) {
        const info = await connection.getAccountInfo(feeSharingConfigPda(mint));
        if (!info) hasSharingConfig = false;
      }
    }

    const feeDestination = isCashbackCoin ? "cashback" : hasSharingConfig ? "sharing_config" : "creator";
    let creatorVaultLamports = new BN(0);

    if (!isCashbackCoin) {
      const vaultCreator = hasSharingConfig ? feeSharingConfigPda(mint) : effectiveCreator;
      const creatorVault = creatorVaultPda(vaultCreator);
      const vaultInfo = await connection.getAccountInfo(creatorVault);
      if (vaultInfo) {
        const adjusted = new BN(vaultInfo.lamports).sub(RENT);
        if (adjusted.gt(new BN(0))) creatorVaultLamports = creatorVaultLamports.add(adjusted);
      }

      const authority = coinCreatorVaultAuthorityPda(vaultCreator);
      const ata = coinCreatorVaultAtaPda(authority, NATIVE_MINT, TOKEN_PROGRAM_ID);
      const ataInfo = await connection.getAccountInfo(ata);
      if (ataInfo) {
        const data = new Uint8Array(ataInfo.data.buffer, ataInfo.data.byteOffset, ataInfo.data.byteLength);
        const parsed = AccountLayout.decode(data);
        creatorVaultLamports = creatorVaultLamports.add(new BN(parsed.amount.toString()));
      }
    }

    res.setHeader("Cache-Control", "no-store");
    return res.status(200).json({
      mint: mint.toBase58(),
      creator: effectiveCreator.toBase58(),
      bondingCurve: bondingCurveAddress.toBase58(),
      isGraduated,
      isCashbackCoin,
      hasSharingConfig,
      feeDestination,
      creatorVaultLamports: creatorVaultLamports.toString(),
      updatedAt: new Date().toISOString()
    });
  } catch (error) {
    return res.status(500).json({ error: "Unable to read creator fees", detail: error?.message || String(error) });
  }
}
