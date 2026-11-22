// Everything waiting on the DM from the players, in one place: coin and item approvals, and requests for edits, pages and answers.
// The old /dm/approvals and /dm/requests routes redirect here.
import { useSearchParams } from 'react-router-dom';
import { PageHead, Tabs } from '../../ui/index.tsx';
import { useWorld, useLoad } from '../../lib/world.tsx';
import DMApprovals from '../broker/DMApprovals.tsx';
import DMRequests from './Requests.tsx';

type Tab = 'approvals' | 'requests';

export default function DMInbox() {
  const { w } = useWorld();
  const [params, setParams] = useSearchParams();
  const tab: Tab = params.get('tab') === 'requests' ? 'requests' : 'approvals';
  const requests = useLoad(() => w.requests(), [w], ['request']);
  const approvals = useLoad(() => w.call<any>('GET', '/approvals'), [w], ['approval', 'coin', 'item', 'item-removed']);
  const c = approvals.data?.counts;
  const nApprovals = c ? c.coin + c.items + c.disputes : 0;
  const nRequests = (requests.data ?? []).filter((r: any) => r.status === 'open').length;
  return (
    <div className="page wide">
      <PageHead title="Inbox" lead="What players are waiting on you for." popout={tab === 'approvals'}>
        <Tabs<Tab> label="Inbox" value={tab} onChange={(t) => setParams({ tab: t }, { replace: true })}
          items={[['approvals', `Approvals${nApprovals ? ` (${nApprovals})` : ''}`], ['requests', `Requests${nRequests ? ` (${nRequests})` : ''}`]]} />
      </PageHead>
      {tab === 'approvals' ? <DMApprovals embedded /> : <DMRequests embedded />}
    </div>
  );
}
