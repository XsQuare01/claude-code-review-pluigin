// 파일 목록에 보여 줄 경로. 빈 조각(앞뒤·중복 슬래시)을 버린다.
export const toDisplayPath = (input: string): string =>
  input
    .split('/')
    .filter(segment => segment.length > 0)
    .join('/')
