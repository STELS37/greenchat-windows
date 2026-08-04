export interface ReportOverlayToken {
  revision: number;
}

export interface ReportOverlayEpoch {
  begin(): ReportOverlayToken | null;
  isCurrent(token: ReportOverlayToken): boolean;
  close(): boolean;
}

export function createReportOverlayEpoch(): ReportOverlayEpoch {
  let revision = 0;
  let closed = false;

  return {
    begin(): ReportOverlayToken | null {
      if (closed) return null;
      revision += 1;
      return { revision };
    },
    isCurrent(token): boolean {
      return !closed && token.revision === revision;
    },
    close(): boolean {
      if (closed) return false;
      closed = true;
      revision += 1;
      return true;
    },
  };
}
