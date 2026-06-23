import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { SERVER_SIMPLE_MIGRATIONS } from '../../src/migrations/server-simple/index.js';

describe('server-simple coverage', () => {
  it('covers v001-v089 simple migrations + v091 compiled_via (raw 9 + PG-only v071/v072 deferred; v074=W2.1; v075=P0-E hash chain; v076=P1-F SOC2; v077=P1-N legal holds; v078=P1-M v2 break-glass jti; v079=P0-E v2 audit chain anchors; v080=P0-D #2 jwt signing keys; v081=GA §8 #1 audit anchor failures; v082=ADR-0047 distillation artifacts; v083=ADR-0047/0048 persona leases; v084=ADR-0047 response templates; v085=ADR-0047 persona rules; v086=BYOK llm provider credentials; v087=BYOK tenant llm settings; v088=ADR-0052 perception media refs; v089=perception event audit; v091=ADR-0047 growth budget compiled_via; v093=ADR-0054 proactive messages; v110=ADR-0057 L2 learning_requests; v111=ADR-0057 L7 capability_index; v112=ADR-0057 L8a org_tasks resume guard; v113=digital workforce org_wallet; v114=bidirectional task market ADR-0058)', () => {
    const versions = SERVER_SIMPLE_MIGRATIONS
      .map(migration => migration.aliases.postgres ?? migration.aliases['sqlite-sql'])
      .filter((version): version is string => Boolean(version))
      .sort();

    assert.deepEqual(versions, [
      'v001', 'v002', 'v003', 'v004', 'v005', 'v006', 'v008', 'v009', 'v010',
      'v011', 'v012', 'v013', 'v014', 'v015', 'v016', 'v017', 'v018', 'v019',
      'v020', 'v021', 'v022', 'v023', 'v024', 'v025', 'v026', 'v028', 'v029',
      'v031', 'v032', 'v033', 'v035', 'v036', 'v037', 'v038', 'v039', 'v042',
      'v043', 'v044', 'v045', 'v046', 'v048', 'v049', 'v050', 'v051', 'v053',
      'v054', 'v055', 'v056', 'v057', 'v058', 'v059', 'v060', 'v061', 'v062',
      'v063', 'v064', 'v065', 'v066', 'v067', 'v068', 'v069', 'v070', 'v073',
      'v074', 'v075', 'v076', 'v077', 'v078', 'v079', 'v080', 'v081',
      'v082', 'v083', 'v084', 'v085', 'v086', 'v087', 'v088', 'v089', 'v091', 'v092',
      'v093', 'v094', 'v095', 'v096', 'v097', 'v098', 'v099', 'v100', 'v101', 'v102', 'v103', 'v104', 'v105', 'v106', 'v107',
      /* ADR-0057：L2 学习请求账本（pg alias v110）+ L7 能力索引（pg alias v111）+ L8a 唤醒守卫（pg alias v112）。 */
      'v110', 'v111', 'v112',
      /* digital workforce 组织金库（pg alias v113）。 */
      'v113',
      /* 双边工单市场 ADR-0058（pg alias v114）。 */
      'v114',
    ]);
  });
});
