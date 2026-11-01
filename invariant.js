const PACKAGE_NAME = 'dsh-plc-decode'

/** Cordis companion plugin name. */
export const name = 'dsh-plc-decode-invariant'
/** Service required before the companion can reserve package ownership. */
export const inject = ['invariants']

const install = () => {}

export const apply = (ctx) => Promise.resolve(ctx.invariants.register(PACKAGE_NAME, install))
