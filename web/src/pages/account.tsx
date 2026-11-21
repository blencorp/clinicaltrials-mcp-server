import { CopyField } from '@/components/kit/copy-field';
import { Notice } from '@/components/kit/notice';
import { Loading, Shell, SignedInAs, SignOut } from '@/components/kit/shell';
import { api, type Account as AccountData } from '@/lib/api';
import { useLoad } from '@/lib/use-load';

export function Account() {
  const { data, error } = useLoad(() => api<AccountData>('/account'), '/account');
  if (error)
    return (
      <Shell title="Your account">
        <Notice>{error}</Notice>
      </Shell>
    );
  if (!data) return <Loading />;
  return (
    <Shell title="Your account" description={<SignedInAs email={data.email} />} action={<SignOut then="/" />}>
      <div className="grid gap-2">
        <h2 className="text-base font-semibold">Connect your assistant</h2>
        <p className="text-muted-foreground text-sm">
          Add this URL as a custom connector (remote MCP server). You sign in once; no API key is needed.
        </p>
        <CopyField value={data.mcpUrl} label="the signed-in server URL" />
      </div>
    </Shell>
  );
}
