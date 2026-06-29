/**
 * 共享 UI 组件 barrel —— 统一导入入口。
 *
 * P2 groundwork（统一设计底座）：把这 25 个组件聚成单一入口，是未来抽出 `@chrono/ui` 包
 * （enterprise + companion 两 variant）的落点——届时此文件成为包 entry，import 路径只换前缀。
 * 当前纯 re-export，零行为变化；新代码可 `import { Button, Modal } from '@/components/ui'`。
 *
 * ⚠️ 抽 @chrono/ui 包本体 + companion（CSS-class 而非 React 组件）迁移是大重构，已记入蓝图
 * 「长期/非紧急」，需专门排期，不在本轮（见 .ccg/tasks/unify-design-system-research/）。
 */
export { Breadcrumbs } from './Breadcrumbs';
export { Button, type ButtonVariant, type ButtonSize } from './Button';
export { DataTable, type Column } from './DataTable';
export { Drawer } from './Drawer';
export { EmptyState } from './EmptyState';
export { FeatureGate } from './FeatureGate';
export { FormField } from './FormField';
export { LanguageSwitcher } from './LanguageSwitcher';
export { LiveIndicator } from './LiveIndicator';
export { LogTimeline } from './LogTimeline';
export { MetricCard } from './MetricCard';
export { MetricSelector } from './MetricSelector';
export { Modal } from './Modal';
export { NetworkStatus } from './NetworkStatus';
export { RadioGroup } from './RadioGroup';
export { ResolutionToggle } from './ResolutionToggle';
export { SSOButton, buildOidcLoginUrl } from './SSOButton';
export { SafetyErrorBanner, type SafetyErrorKind } from './SafetyErrorBanner';
export { ShareModal } from './ShareModal';
export { Skeleton } from './Skeleton';
export { StatsTable } from './StatsTable';
export { StatusBadge } from './StatusBadge';
export { Stepper } from './Stepper';
export { SyncStatusIndicator } from './SyncStatusIndicator';
export { Tabs } from './Tabs';
export { TrustBadge, type InitiatorType } from './TrustBadge';
