import { useStore } from '../../stores';
import { RegionalErrorBoundary } from '../RegionalErrorBoundary';
import { RightWorkspacePanel } from '../right-workspace/RightWorkspacePanel';
import { WorkspaceFileChangeBridge } from './WorkspaceFileChangeBridge';

export function WorkspaceCompanionRail() {
  const jianOpen = useStore(s => s.jianOpen);

  return (
    <>
      <WorkspaceFileChangeBridge />
      <aside className={`jian-sidebar${jianOpen ? '' : ' collapsed'}`} id="jianSidebar">
        <div className="resize-handle resize-handle-left" id="jianResizeHandle"></div>
        <div className="jian-sidebar-inner">
          <RegionalErrorBoundary region="right-workspace">
            <RightWorkspacePanel />
          </RegionalErrorBoundary>
        </div>
      </aside>
    </>
  );
}
