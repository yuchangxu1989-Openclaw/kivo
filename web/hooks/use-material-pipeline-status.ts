import useSWR from 'swr';
import { apiFetch } from '@/lib/client-api';

export type ImportPipelineStatus = 'pending' | 'slicing' | 'extracting' | 'injecting' | 'done' | 'failed';

export interface MaterialPipelineStatusResponse {
  data: {
    materialId: string;
    fileName: string;
    status: ImportPipelineStatus;
    pipelineStatus: string | null;
    classificationStatus: string | null;
    totalChunks: number | null;
    processedChunks: number;
    progress: number | null;
    knowledgeEntryCount: number;
    wikiPageCount: number;
    outputPages: Array<{ id: string; title: string; href: string }>;
    lastError: string | null;
    updatedAt: string;
  };
}

export function useMaterialPipelineStatus(materialId: string | null) {
  return useSWR<MaterialPipelineStatusResponse, Error>(
    materialId ? `/api/v1/wiki/materials/${materialId}/status` : null,
    (url: string) => apiFetch<MaterialPipelineStatusResponse>(url),
    {
      refreshInterval: (latest) => {
        const status = latest?.data.status;
        return status === 'done' || status === 'failed' ? 0 : 2000;
      },
      revalidateOnFocus: false,
    },
  );
}
