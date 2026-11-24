/**
 * Image markets over HTTP: which markets there are, and a folder of one. The same for every market kind (see
 * `markets.ts`): the page and the CLI browse any of them alike, and a market's own configuration never reaches here.
 */
import { required, type Endpoint } from './api.ts'
import type { BoardLab } from './lab.ts'

export function marketEndpoints(lab: BoardLab): Endpoint[] {
  return [
    { method: 'GET', path: '/api/markets', about: '设好的镜像市场：编号、种类、名字、谁设的，用不了时说为什么', handle: () => lab.markets.list() },
    {
      method: 'GET', path: '/api/markets/:id/list',
      about: '一个镜像市场里的一层（path，空是顶层）：文件夹在前，新的在前；soc 只留这个 SoC 的；board 给出时每个镜像带 refused（这块板子的后端为什么刷不了它，能刷是 null）；一分钟内不再问市场，refresh=1 重新读',
      handle: ({ params, query, signal }) => {
        const name = query.get('board')
        return lab.markets.folder(required(params.id, 'id'), query.get('path') ?? '', { soc: query.get('soc'), refresh: query.get('refresh') === '1', signal, board: name ? lab.boards.get(name) : null })
      },
    },
    {
      method: 'GET', path: '/api/markets/:id/search',
      about: '在镜像市场里找（q）：读整个树，只留名字里有 q 的镜像和通往它们的文件夹，按树的位置排好（页面整棵展开）；soc 只留这个 SoC 的，board 同 /list；folders 读了多少个文件夹，partial=1 表示没读完（文件夹太多或超时）',
      handle: ({ params, query, signal }) => {
        const name = query.get('board')
        return lab.markets.search(required(params.id, 'id'), required(query.get('q'), 'q'), { soc: query.get('soc'), refresh: query.get('refresh') === '1', signal, board: name ? lab.boards.get(name) : null })
      },
    },
    {
      method: 'GET', path: '/api/markets/:id/targets',
      about: '一个镜像（path）能刷到哪些板子上：后端收这种包、SoC 对得上的；你拿着的在前，再是空闲的，其余说为什么不行',
      handle: ({ params, query, caller, signal }) => lab.markets.targets(required(params.id, 'id'), required(query.get('path'), 'path'), caller.holder, lab.boards.list(), signal),
    },
  ]
}
