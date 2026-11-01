// 소스를 그대로 쓸 때의 워커 주소. 빌드(scripts/build.ts)는 이 모듈을 워커를 묶어 넣은 Blob 주소로 바꿔,
// 쓰는 쪽 번들러가 워커 파일을 따로 챙기지 않아도 되게 한다
export const workerUrl = () => new URL("./worker.ts", import.meta.url);
