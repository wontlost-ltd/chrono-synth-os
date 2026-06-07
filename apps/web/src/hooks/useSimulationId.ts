import { useParams } from 'react-router-dom';
import { useTranslation } from 'react-i18next';

/** 从 URL 参数提取 simulationId */
export function useSimulationId(): string {
  const { t } = useTranslation();
  const { id } = useParams<{ id: string }>();
  if (!id) throw new Error(t('errors.missingSimulationId'));
  return id;
}
