/**
 * The module markets over HTTP: which markets a boardd was started with, what each offers, and which of its modules
 * boardd loaded. Read-only: adding, updating or removing a market changes what the next boardd process loads, so the
 * CLI does it against the state directory, not through a running boardd.
 */
import type { Endpoint } from './api.ts'
import type { BoardLab } from './lab.ts'

export function moduleMarketEndpoints(lab: BoardLab): Endpoint[] {
  return [
    {
      method: 'GET', path: '/api/module-markets',
      about: '装了哪些模块市场，各自从哪来、在哪个提交上、提供哪些模块（id、说明、标签、要什么、给什么），以及复制品有什么问题',
      handle: () => ({ markets: lab.moduleMarkets, problems: lab.moduleMarkets.flatMap(market => market.problems) }),
    },
    {
      method: 'GET', path: '/api/module-markets/:id',
      about: '一个模块市场：它提供哪些模块，每个是装了、等着缺的服务、起不来，还是没被选上',
      handle: ({ params }) => {
        const market = lab.moduleMarkets.find(item => item.id === params.id)
        if (!market) return { market: null }
        const loaded = new Map(lab.plugins().map(plugin => [plugin.id, plugin]))
        return { market, modules: market.modules.map(offered => ({ offered, loaded: loaded.get(offered.id) ?? null })) }
      },
    },
  ]
}
