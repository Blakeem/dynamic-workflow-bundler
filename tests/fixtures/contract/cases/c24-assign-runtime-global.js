export const meta = { name: 'p', description: 'd' }
const out = {}
for (const name of ['agent', 'parallel', 'pipeline', 'phase', 'log', 'args', 'budget', 'workflow', 'console', 'setTimeout']) {
  try { (0, eval) } catch {}
}
try { agent = 1; out.agent = 'assigned ' + typeof agent } catch (e) { out.agent = 'threw: ' + e.message }
try { args = 1; out.args = 'assigned ' + typeof args } catch (e) { out.args = 'threw: ' + e.message }
try { log = 1; out.log = 'assigned ' + typeof log } catch (e) { out.log = 'threw: ' + e.message }
try { budget.total = 5; out.budget = 'assigned ' + budget.total } catch (e) { out.budget = 'threw: ' + e.message }
return out
