import { BigNumber, Contract, FixedNumber } from 'ethers'
import { DateTime } from 'luxon'
import { PubKey } from 'maci-domainobjs'

import { FundingRound, MACI, ERC20 } from './abi'
import { provider, factory, extraRounds } from './core'
import { getTotalContributed } from './contributions'

export interface RoundInfo {
  fundingRoundAddress: string;
  roundNumber: number;
  userRegistryAddress: string;
  maciAddress: string;
  recipientTreeDepth: number;
  startBlock: number;
  endBlock: number;
  coordinatorPubKey: PubKey;
  nativeTokenAddress: string;
  nativeTokenSymbol: string;
  nativeTokenDecimals: number;
  voiceCreditFactor: BigNumber;
  status: string;
  signUpDeadline: DateTime;
  votingDeadline: DateTime;
  totalFunds: FixedNumber;
  matchingPool: FixedNumber;
  contributions: FixedNumber;
  contributors: number;
}

export enum RoundStatus {
  Contributing = 'Contributing',
  Reallocating = 'Reallocating',
  Tallying = 'Tallying',
  Finalized = 'Finalized',
  Cancelled = 'Cancelled',
}

export async function getCurrentRound(): Promise<string | null> {
  const fundingRoundAddress = await factory.getCurrentRound()
  if (fundingRoundAddress === '0x0000000000000000000000000000000000000000') {
    return null
  }
  return fundingRoundAddress
}

async function getApprovedFunding(
  fundingRound: Contract,
  token: Contract,
): Promise<BigNumber> {
  // TODO: replace with single call when necessary getter will be implemented
  const addSourceFilter = factory.filters.FundingSourceAdded()
  const addSourceEvents = await factory.queryFilter(addSourceFilter, 0)
  const removeSourceFilter = factory.filters.FundingSourceRemoved()
  const removeSourceEvents = await factory.queryFilter(removeSourceFilter, 0)
  let total = BigNumber.from(0)
  for (const event of addSourceEvents) {
    const sourceAddress = (event.args as any)._source
    const removed = removeSourceEvents.find((event) => {
      return (event.args as any)._source === sourceAddress
    })
    if (removed) {
      continue
    }
    const allowance = await token.allowance(sourceAddress, factory.address)
    const balance = await token.balanceOf(sourceAddress)
    const contribution = allowance.lt(balance) ? allowance : balance
    total = total.add(contribution)
  }
  return total
}

async function getRoundNumber(roundAddress: string): Promise<number> {
  const eventFilter = factory.filters.RoundStarted()
  const events = await factory.queryFilter(eventFilter, 0)
  const roundIndex = events.findIndex((event) => {
    const args = (event.args as any)
    return args._round.toLowerCase() === roundAddress.toLowerCase()
  })
  if (roundIndex === -1) {
    throw new Error('round does not exist')
  }
  return roundIndex + extraRounds.length
}

export async function getRoundInfo(fundingRoundAddress: string): Promise<RoundInfo> {
  const roundNumber = await getRoundNumber(fundingRoundAddress)
  const fundingRound = new Contract(
    fundingRoundAddress,
    FundingRound,
    provider,
  )
  const [
    maciAddress,
    nativeTokenAddress,
    userRegistryAddress,
    startBlock,
    voiceCreditFactor,
    isFinalized,
    isCancelled,
  ] = await Promise.all([
    fundingRound.maci(),
    fundingRound.nativeToken(),
    fundingRound.userRegistry(),
    fundingRound.startBlock(),
    fundingRound.voiceCreditFactor(),
    fundingRound.isFinalized(),
    fundingRound.isCancelled(),
  ])

  const maci = new Contract(maciAddress, MACI, provider)
  const [
    maciTreeDepths,
    signUpTimestamp,
    signUpDurationSeconds,
    votingDurationSeconds,
    coordinatorPubKeyRaw,
  ] = await Promise.all([
    maci.treeDepths(),
    maci.signUpTimestamp(),
    maci.signUpDurationSeconds(),
    maci.votingDurationSeconds(),
    maci.coordinatorPubKey(),
  ])
  const signUpDeadline = DateTime.fromSeconds(
    signUpTimestamp.add(signUpDurationSeconds).toNumber(),
  )
  const votingDeadline = DateTime.fromSeconds(
    signUpTimestamp.add(signUpDurationSeconds).add(votingDurationSeconds).toNumber(),
  )
  const endBlock = startBlock.add(
    // Average block time is 15 seconds
    signUpDurationSeconds.add(votingDurationSeconds).div(15),
  )
  const coordinatorPubKey = new PubKey([
    BigInt(coordinatorPubKeyRaw.x),
    BigInt(coordinatorPubKeyRaw.y),
  ])

  const nativeToken = new Contract(
    nativeTokenAddress,
    ERC20,
    provider,
  )
  const nativeTokenSymbol = await nativeToken.symbol()
  const nativeTokenDecimals = await nativeToken.decimals()

  const now = DateTime.local()
  const contributionsInfo = await getTotalContributed(fundingRoundAddress)
  let status: string
  let contributions: BigNumber
  let matchingPool: BigNumber
  if (isCancelled) {
    status = RoundStatus.Cancelled
    contributions = BigNumber.from(0)
    matchingPool = BigNumber.from(0)
  } else if (isFinalized) {
    status = RoundStatus.Finalized
    contributions = (await fundingRound.totalSpent()).mul(voiceCreditFactor)
    matchingPool = await fundingRound.matchingPoolSize()
  } else {
    if (now < signUpDeadline) {
      status = RoundStatus.Contributing
    } else if (now < votingDeadline) {
      status = RoundStatus.Reallocating
    } else {
      status = RoundStatus.Tallying
    }
    contributions = contributionsInfo.amount
    const lockedFunding = await nativeToken.balanceOf(factory.address)
    const approvedFunding = await getApprovedFunding(fundingRound, nativeToken)
    matchingPool = lockedFunding.add(approvedFunding)
  }

  const totalFunds = matchingPool.add(contributions)

  return {
    fundingRoundAddress,
    roundNumber,
    userRegistryAddress,
    maciAddress,
    recipientTreeDepth: maciTreeDepths.voteOptionTreeDepth,
    startBlock: startBlock.toNumber(),
    endBlock: endBlock.toNumber(),
    coordinatorPubKey,
    nativeTokenAddress,
    nativeTokenSymbol,
    nativeTokenDecimals,
    voiceCreditFactor,
    status,
    signUpDeadline,
    votingDeadline,
    totalFunds: FixedNumber.fromValue(totalFunds, nativeTokenDecimals),
    matchingPool: FixedNumber.fromValue(matchingPool, nativeTokenDecimals),
    contributions: FixedNumber.fromValue(contributions, nativeTokenDecimals),
    contributors: contributionsInfo.count,
  }
}
