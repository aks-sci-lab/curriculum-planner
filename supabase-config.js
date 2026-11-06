"use strict";
// 웹 수강신청 서버(Supabase) 주소와 공개 키. 앱(supabase-client.js)과 수강신청 테스트봇(test-bot.js)이 같은 값을 쓴다.
// 공개 키(publishable)는 브라우저에 노출되도록 만든 값이며, 권한은 서버의 RPC·행 보안 규칙이 정한다.
var CURRICULUM_SUPABASE_CONFIG = Object.freeze({
  projectUrl: "https://hapfkdkbhnqpfjdepozv.supabase.co",
  publicKey: "sb_publishable_HCUWUrxTxaDVtwv4KvPj4A_4RKnLD-p",
});
