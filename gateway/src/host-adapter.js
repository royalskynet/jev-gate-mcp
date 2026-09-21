// Concrete host-enforcement adapter. It translates lifecycle boundaries into
// server-owned policies and only invokes execute() after a literal `accept`.
// A tool registration cannot provide this guarantee; host code must wrap its
// actual execution boundary with this adapter.
const POLICY_BY_BOUNDARY = Object.freeze({
  before_action: 'proposed-action-risk',
  after_external_result: 'context-screening',
  before_finish: 'completion-claims',
});

export function createHostAdapter({ applyPolicy, metrics } = {}) {
  if (typeof applyPolicy !== 'function') throw new TypeError('applyPolicy function required');

  return {
    async enforce({ boundary, state, correlation, policy = POLICY_BY_BOUNDARY[boundary], execute }) {
      if (!POLICY_BY_BOUNDARY[boundary]) throw new TypeError(`unknown lifecycle boundary: ${boundary}`);
      if (!policy) throw new TypeError(`no policy mapped for boundary: ${boundary}`);
      if (typeof execute !== 'function') throw new TypeError('execute function required');

      const decision = await applyPolicy({ policy, state, correlation });
      if (decision.outcome !== 'accept') {
        metrics?.recordWorkflow({ policy, boundary, gate: decision.outcome, resolution: 'stopped' });
        return { executed: false, decision };
      }

      try {
        const value = await execute();
        metrics?.recordWorkflow({ policy, boundary, gate: 'accept', resolution: 'executed' });
        return { executed: true, decision, value };
      } catch (error) {
        metrics?.recordWorkflow({ policy, boundary, gate: 'accept', resolution: 'execution_error' });
        throw error;
      }
    },

    recordResolution({ decision, boundary, resolution, retry_cost = 0, false_accept_severity = null }) {
      const policy = decision?.policy?.id;
      const gate = decision?.outcome;
      if (!policy || !gate || !POLICY_BY_BOUNDARY[boundary]) throw new TypeError('valid decision and boundary required');
      metrics?.recordWorkflow({ policy, boundary, gate, resolution, retry_cost, false_accept_severity });
    },
  };
}

/** Adapt an initialized MCP Client without coupling host enforcement to a vendor. */
export function createMcpHostAdapter(client, opts = {}) {
  return createHostAdapter({
    metrics: opts.metrics,
    applyPolicy: async (args) => {
      const result = await client.callTool({ name: 'jev_apply_policy', arguments: args });
      if (result.isError) throw new Error('jev_apply_policy returned an MCP error');
      if (result.structuredContent) return result.structuredContent;
      const text = (result.content ?? []).find((item) => item.type === 'text')?.text;
      if (!text) throw new Error('jev_apply_policy returned no structured result');
      return JSON.parse(text);
    },
  });
}

export { POLICY_BY_BOUNDARY };
