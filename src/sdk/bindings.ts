/**
 * The JS source for the `ctgov` object available inside the sandbox.
 * Bundled as a string so both isolated-vm and the Deno subprocess can load it.
 *
 * Every call dispatches through `__host.rpc(method, args)`, which the host
 * wires to the supervisor-backed `RpcDispatch` function.
 */
export const CTGOV_SDK_SHIM = /* js */ `
"use strict";
(function (globalCtx, hostCtx) {
  function rpc(method, args) { return hostCtx.rpc(method, args); }

  function asyncIterFromPaged(params, opts) {
    var maxPages = Math.min((opts && opts.maxPages) || 10, 100);
    var pageSize = (opts && opts.pageSize) || 100;
    var token;
    var done = false;
    return {
      [Symbol.asyncIterator]() {
        var buffer = [];
        var pageIndex = 0;
        return {
          async next() {
            while (buffer.length === 0) {
              if (done || pageIndex >= maxPages) return { value: undefined, done: true };
              var q = Object.assign({}, params, { pageSize });
              if (token) q.pageToken = token;
              var page = await rpc("studies.search", q);
              pageIndex++;
              (page && page.studies ? page.studies : []).forEach(function (s) { buffer.push(s); });
              if (!page || !page.nextPageToken) { done = true; } else { token = page.nextPageToken; }
            }
            return { value: buffer.shift(), done: false };
          },
        };
      },
    };
  }

  var ctgov = {
    studies: {
      search: function (p) { return rpc("studies.search", p || {}); },
      searchAll: function (p, o) { return asyncIterFromPaged(p || {}, o || {}); },
      get: function (nctId, p) { return rpc("studies.get", Object.assign({ nctId }, p || {})); },
      metadata: function (p) { return rpc("studies.metadata", p || {}); },
      searchAreas: function () { return rpc("studies.searchAreas", {}); },
      enums: function () { return rpc("studies.enums", {}); },
    },
    stats: {
      size: function () { return rpc("stats.size", {}); },
      fieldValues: function (p) { return rpc("stats.fieldValues", p); },
      fieldSizes: function (p) { return rpc("stats.fieldSizes", p); },
    },
    version: function () { return rpc("version", {}); },
  };

  globalCtx.ctgov = ctgov;
})(globalThis, __host);
`;
