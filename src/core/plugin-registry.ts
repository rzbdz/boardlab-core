/**
 * The lab's extension points, as a plugin's context registers them and takes them back: every array and map a module
 * adds to has a matching undo here, so a module that is taken down leaves nothing behind.
 *
 * Each entry calls the lab method that keeps its own undo (`lab.api.addOne`, `lab.locks.addTarget`, …) and hands that
 * undo back. A registration made inside `ctx.effect` is undone with the effect; one made inside a module's setup is
 * recorded with the module by the lab method itself; the same call from boardd's own code, outside any module, stands
 * for the life of the lab. This is how a module written before the plugin runtime — one that calls `lab.api.add`,
 * `lab.addState`, `lab.backends.register` directly — still gets taken down cleanly: it never had to hold an undo.
 */
import type { BoardLab } from './lab.ts'
import type { Registry } from './plugin.ts'

export function registryOf(lab: BoardLab): Registry {
  return {
    endpoint: (module, endpoint) => lab.api.addOne(module, endpoint as never),
    view: view => { lab.boards.addView(view as never); return () => lab.boards.removeView(view as never) },
    lockTarget: exists => { lab.locks.addTarget(exists); return () => lab.locks.removeTarget(exists) },
    lockOccupant: occupant => { lab.locks.addOccupant(occupant); return () => lab.locks.removeOccupant(occupant) },
    lockFollower: follower => { lab.locks.addFollower(follower as never); return () => lab.locks.removeFollower(follower as never) },
    state: part => { lab.addState(part); return () => lab.removeState(part) },
    history: part => { lab.addHistory(part); return () => lab.removeHistory(part) },
    service: service => { lab.addService(service); return () => lab.removeService(service) },
    backend: (id, backend, options) => { lab.backends.register(id, backend as never, options); return () => lab.backends.unregister(id) },
    labKind: kind => { lab.backends.offer(kind as never); return () => lab.backends.withdraw((kind as { kind: string }).kind) },
    event: (event, listener) => {
      lab.kernel.events.on(event, listener as never)
      return () => { lab.kernel.events.off(event, listener as never) }
    },
  }
}
