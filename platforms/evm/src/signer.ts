import type {
  Network,
  SignOnlySigner,
  SignedTx,
  Signer,
  UnsignedTransaction,
} from '@wormhole-foundation/sdk-connect';
import {
  PlatformNativeSigner,
  chainToPlatform,
  isNativeSigner,
} from '@wormhole-foundation/sdk-connect';
import type {
  Signer as EthersSigner,
  Provider,
  TransactionRequest,
} from 'ethers';
import { NonceManager, Wallet } from 'ethers';
// Import quais for Quai support
import type {
  Signer as QuaiSigner,
  TransactionRequest as QuaiTransactionRequest,
} from 'quais';
import { JsonRpcProvider as QuaiJsonRpcProvider, Wallet as QuaiWalletImpl, Zone } from 'quais';
import { EvmPlatform } from './platform.js';
import type { EvmChains } from './types.js';
import { _platform } from './types.js';

export type EvmSignerOptions = {
  // Whether or not to log messages
  debug?: boolean;
  // Override gas limit
  gasLimit?: bigint;
  // Do not exceed this gas limit
  maxGasLimit?: bigint;
  // Partially override specific transaction request fields
  overrides?: Partial<TransactionRequest>;
};

export async function getEvmSigner(
  rpc: Provider,
  key: string | EthersSigner,
  opts?: EvmSignerOptions & { chain?: EvmChains },
): Promise<Signer> {
  const chain = opts?.chain ?? (await EvmPlatform.chainFromRpc(rpc))[1];
  
  // Check if this is Quai and use quais.js instead of ethers
  if (chain === 'QuaiTestnet') {
    return getQuaiSigner(rpc, key, opts);
  }

  const signer: EthersSigner =
    typeof key === 'string' ? new Wallet(key, rpc) : key;

  const managedSigner = new NonceManager(signer);

  if (managedSigner.provider === null) {
    try {
      managedSigner.connect(rpc);
    } catch (e) {
      console.error('Cannot connect to network for signer', e);
    }
  }

  return new EvmNativeSigner(
    chain,
    await signer.getAddress(),
    managedSigner,
    opts,
  );
}

// Quai-specific signer function using quais.js
async function getQuaiSigner(
  rpc: Provider,
  key: string | EthersSigner,
  opts?: EvmSignerOptions & { chain?: EvmChains },
): Promise<Signer> {
  let quaiSigner: QuaiSigner;
  
  if (typeof key === 'string') {
    // Private key case - create wallet with provider
    const rpcUrl = (rpc as any).connection?.url || '';
    if (!rpcUrl) {
      throw new Error('Unable to extract RPC URL for Quai provider');
    }
    
    const quaiProvider = new QuaiJsonRpcProvider(rpcUrl);
    quaiSigner = new QuaiWalletImpl(key, quaiProvider);
  } else {
    // Wallet case - assume key is already a quais Signer from BrowserProvider
    // This handles window.pelagus.getSigner() which returns a quais Signer
    quaiSigner = key as any as QuaiSigner;
  }

  const chain = opts?.chain ?? 'QuaiTestnet' as EvmChains;

  return new QuaiNativeSigner(
    chain,
    await quaiSigner.getAddress(),
    quaiSigner,
    opts,
  );
}

// Get a SignOnlySigner for the EVM platform
export async function getEvmSignerForKey(
  rpc: Provider,
  privateKey: string,
): Promise<Signer> {
  return getEvmSigner(rpc, privateKey);
}

// Get a SignOnlySigner for the EVM platform
export async function getEvmSignerForSigner(
  signer: EthersSigner,
): Promise<Signer> {
  if (!signer.provider) throw new Error('Signer must have a provider');
  return getEvmSigner(signer.provider!, signer, {});
}

// Get a SignOnlySigner for Quai using quais Signer
export async function getQuaiSignerForSigner(
  signer: QuaiSigner,
): Promise<Signer> {
  if (!signer.provider) throw new Error('Quai signer must have a provider');
  
  // Create a dummy ethers provider since getEvmSigner expects one
  // The actual provider logic is handled in getQuaiSigner
  const dummyProvider = {} as Provider;
  
  return getEvmSigner(dummyProvider, signer as any, { chain: 'QuaiTestnet' });
}

export class EvmNativeSigner<N extends Network, C extends EvmChains = EvmChains>
  extends PlatformNativeSigner<EthersSigner, N, C>
  implements SignOnlySigner<N, C>
{
  constructor(
    _chain: C,
    _address: string,
    _signer: EthersSigner,
    readonly opts?: EvmSignerOptions,
  ) {
    super(_chain, _address, _signer);
  }

  chain(): C {
    return this._chain;
  }

  address(): string {
    return this._address;
  }

  async sign(tx: UnsignedTransaction<N, C>[]): Promise<SignedTx[]> {
    const chain = this.chain();

    const signed = [];

    // Default gas values
    let gasLimit = 500_000n;
    let gasPrice = 100_000_000_000n; // 100gwei
    let maxFeePerGas = 1_500_000_000n; // 1.5gwei
    let maxPriorityFeePerGas = 100_000_000n; // 0.1gwei

    // If no overrides were passed, we can get better
    // gas values from the provider
    if (this.opts?.overrides === undefined) {
      // Celo does not support this call
      if (chain !== 'Celo') {
        const feeData = await this._signer.provider!.getFeeData();
        gasPrice = feeData.gasPrice ?? gasPrice;
        maxFeePerGas = feeData.maxFeePerGas ?? maxFeePerGas;
        maxPriorityFeePerGas =
          feeData.maxPriorityFeePerGas ?? maxPriorityFeePerGas;
      }
    }

    if (this.opts?.gasLimit !== undefined) {
      gasLimit = this.opts.gasLimit;
    }

    if (this.opts?.maxGasLimit !== undefined) {
      // why doesnt math.min work for bigints?
      gasLimit =
        gasLimit > this.opts?.maxGasLimit ? this.opts?.maxGasLimit : gasLimit;
    }

    const gasOpts = { gasLimit, maxFeePerGas, maxPriorityFeePerGas };

    for (const txn of tx) {
      const { transaction, description } = txn;
      if (this.opts?.debug)
        console.log(`Signing: ${description} for ${this.address()}`);

      const t: TransactionRequest = {
        ...transaction,
        ...gasOpts,
        from: this.address(),
        nonce: await this._signer.getNonce(),
        // Override any existing values with those passed in the constructor
        ...this.opts?.overrides,
      };

      signed.push(await this._signer.signTransaction(t));
    }
    return signed;
  }
}

// Quai-specific signer class using quais.js
export class QuaiNativeSigner<N extends Network, C extends EvmChains = EvmChains>
  extends PlatformNativeSigner<QuaiSigner, N, C>
  implements SignOnlySigner<N, C>
{
  constructor(
    _chain: C,
    _address: string,
    _signer: QuaiSigner,
    readonly opts?: EvmSignerOptions,
  ) {
    super(_chain, _address, _signer);
  }

  chain(): C {
    return this._chain;
  }

  address(): string {
    return this._address;
  }

  async sign(tx: UnsignedTransaction<N, C>[]): Promise<SignedTx[]> {
    const signed = [];

    // Default gas values for Quai
    let gasLimit = 500_000n;
    let gasPrice = 100_000_000_000n; // 100gwei

    // Get gas price from provider if available
    if (this.opts?.overrides === undefined) {
      try {
        const feeData = await this._signer.provider!.getFeeData(Zone.Cyprus1, true);
        gasPrice = feeData.gasPrice ?? gasPrice;
      } catch (e) {
        // Use default if fee data fetch fails
      }
    }

    if (this.opts?.gasLimit !== undefined) {
      gasLimit = this.opts.gasLimit;
    }

    if (this.opts?.maxGasLimit !== undefined) {
      gasLimit =
        gasLimit > this.opts?.maxGasLimit ? this.opts?.maxGasLimit : gasLimit;
    }

    const gasOpts = { gasLimit, gasPrice };

    for (const txn of tx) {
      const { transaction, description } = txn;
      if (this.opts?.debug)
        console.log(`Signing: ${description} for ${this.address()}`);

      // Convert ethers TransactionRequest to quais format
      const t: QuaiTransactionRequest = {
        ...transaction,
        ...gasOpts,
        from: this.address(),
        nonce: await this._signer.getNonce(),
        // Override any existing values with those passed in the constructor
        ...this.opts?.overrides,
      };

      signed.push(await this._signer.signTransaction(t));
    }
    return signed;
  }
}

export function isEvmNativeSigner<N extends Network>(
  signer: Signer<N>,
): signer is EvmNativeSigner<N> {
  return (
    isNativeSigner(signer) &&
    chainToPlatform(signer.chain()) === _platform &&
    isEthersSigner(signer.unwrap())
  );
}

// No type guard provided by ethers, instanceof checks will fail on even slightly different versions of ethers
function isEthersSigner(thing: any): thing is EthersSigner {
  return (
    'provider' in thing &&
    typeof thing.connect === 'function' &&
    typeof thing.getAddress === 'function' &&
    typeof thing.getNonce === 'function' &&
    typeof thing.populateCall === 'function' &&
    typeof thing.populateTransaction === 'function' &&
    typeof thing.estimateGas === 'function' &&
    typeof thing.call === 'function' &&
    typeof thing.resolveName === 'function' &&
    typeof thing.signTransaction === 'function' &&
    typeof thing.sendTransaction === 'function' &&
    typeof thing.signMessage === 'function' &&
    typeof thing.signTypedData === 'function'
  );
}
