import { gql, request } from "graphql-request";
import { Liq } from "../utils/types";
import { getPagedGql } from "../utils/gql";

const query = gql`
  query users($lastId: String, $pageSize: Int) {
    users(first: $pageSize, where: { id_gt: $lastId, reserves_: { currentTotalDebt_gt: "0" } }) {
      id
      reserves {
        usageAsCollateralEnabledOnUser
        reserve {
          symbol
          usageAsCollateralEnabled
          underlyingAsset
          price {
            priceInEth
          }
          decimals
          reserveLiquidationThreshold
        }
        currentATokenBalance
        currentTotalDebt
      }
    }
    _meta {
      block {
        number
      }
    }
  }
`;

interface UserReserve {
  debt: number;
  price: number;
  token: string;
  totalBal: string;
  decimals: number;
}

interface LiquidablePosition extends Liq {
  extra: {
    url: string;
  };
}

interface User {
  id: string;
  reserves: {
    usageAsCollateralEnabledOnUser: boolean;
    reserve: {
      symbol: string;
      usageAsCollateralEnabled: boolean;
      underlyingAsset: string;
      price: {
        priceInEth: string;
      };
      decimals: string;
      reserveLiquidationThreshold: string;
    };
    currentATokenBalance: string;
    currentTotalDebt: string;
  }[];
}

const ethPriceQuery = (usdcAddress: string) => gql`
  {
    priceOracleAsset(id: "${usdcAddress}") {
      priceInEth
    }
  }
`;

enum Chains {
  ethereum = "ethereum",
}

type AaveAdapterResource = {
  name: "aave";
  chain: Chains;
  usdcAddress: string;
  subgraphUrl: string;
  explorerBaseUrl: string;
};

const rc: Record<Chains, AaveAdapterResource> = {
  [Chains.ethereum]: {
    name: "aave",
    chain: Chains.ethereum,
    usdcAddress: "0xa0b86991c6218b36c1d19d4a2e9eb0ce3606eb48",
    subgraphUrl: "https://api.thegraph.com/subgraphs/name/aave/protocol-v2",
    explorerBaseUrl: "https://etherscan.io/address/",
  },
};

const calculatePositions = async (chain: Chains): Promise<Liq[]> => {
  const explorerBaseUrl = rc[chain].explorerBaseUrl;
  const subgraphUrl = rc[chain].subgraphUrl;
  const usdcAddress = rc[chain].usdcAddress;
  const ethPriceQueryResult = await request(subgraphUrl, ethPriceQuery(usdcAddress));
  const ethPrice = 1 / (ethPriceQueryResult.priceOracleAsset.priceInEth / 1e18);
  const users = (await getPagedGql(rc[chain].subgraphUrl, query, "users")) as User[];

  const positions = users.flatMap((user) => {
    let totalDebt = 0;
    let totalCollateral = 0;

    const debts: UserReserve[] = user.reserves.map((reserve) => {
      const decimals = 10 ** reserve.reserve.decimals;
      const price = (Number(reserve.reserve.price.priceInEth) / 1e18) * ethPrice;
      const liqThreshold = Number(reserve.reserve.reserveLiquidationThreshold) / 1e4;
      let debt = Number(reserve.currentTotalDebt);

      if (reserve.usageAsCollateralEnabledOnUser === true) {
        debt -= Number(reserve.currentATokenBalance) * liqThreshold;
      }

      debt *= price / decimals;

      if (debt > 0) {
        totalDebt += debt;
      } else {
        totalCollateral -= debt;
      }

      return {
        debt,
        price,
        token: reserve.reserve.underlyingAsset,
        totalBal: reserve.currentATokenBalance,
        decimals,
      };
    });

    const liquidablePositions: LiquidablePosition[] = debts
      .filter(({ debt }) => debt < 0)
      .map((pos) => {
        const usdPosNetCollateral = -pos.debt;
        const otherCollateral = totalCollateral - usdPosNetCollateral;
        const diffDebt = totalDebt - otherCollateral;

        if (diffDebt > 0) {
          const amountCollateral = usdPosNetCollateral / pos.price;
          const liqPrice = diffDebt / amountCollateral;

          return {
            owner: user.id as string,
            liqPrice,
            collateral: `${chain}:` + pos.token,
            collateralAmount: pos.totalBal as string,
            extra: {
              u
