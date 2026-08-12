/** Boots both halves of the demo: the fake Gurb backend and the customer's site. */
import { createMockGurb } from './mock-gurb.mjs'
import { createHostServer } from './host-server.mjs'

createMockGurb().listen(5099, () => console.log('mock Gurb  → http://localhost:5099'))
createHostServer().listen(4099, () => console.log('host site  → http://localhost:4099'))
