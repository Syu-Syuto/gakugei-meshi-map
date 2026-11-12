# LINE管理者通知

通知先は管理者本人のLINE 1人。公式アカウント「しゅうの物置」を送信元にし、公開用の一斉配信はしません。

日本時間6:00・9:00・12:00・16:00・21:00に、未通知の審査待ちがある場合だけ1通にまとめます。31日でも通常最大155通。初回は既存の未通知の審査待ちもまとめます。すでに承認・却下した投稿は新規通知対象にしません。件数と店名、管理画面のリンクだけを送り、写真・コメント・投稿者の性別や識別子は送りません。21時以降の投稿は翌6時の回に入ります。

## 配置

1. 011_line_digest.sqlを適用（通知は初期状態では無効）。
2. Supabase Edge Function `line-digest` にindex.tsとhandler.jsを配置。ブラウザーから呼びません。
3. LINEで長期チャネルアクセストークンを発行。本人が公式アカウントを友だち追加し、チャネル基本設定の「あなたのユーザーID」を通知先として確認。
4. Supabase Edge Function Secretsへ `LINE_CHANNEL_ACCESS_TOKEN`・`LINE_TARGET_USER_ID`・`LINE_DIGEST_CRON_SECRET`・`LINE_DIGEST_ENABLED=true` を保存。鍵やユーザーIDはGitHub・公開config.js・チャット本文に保存しません。
5. line-digest-schedule.sqlでVaultの秘密鍵とCronを用意。Vaultの鍵をEdge FunctionのLINE_DIGEST_CRON_SECRETと一致させます。CronのタイムゾーンがUTCであることを確認します。
6. 宛先・友だち追加・1通のテスト送信を確認後、line_digest_settingsをenabled=trueへ変更。

## 送信の扱い

同じ時刻枠はDBで一度だけ実行し、通信失敗時は次の時刻枠で同じ送信内容・同じX-Line-Retry-Keyを使って再試行します。LINEに受理済みの再試行は409を確認して送信済みにします。送信確認前にキューを完了扱いにしません。23時間を過ぎた未確定の送信は、自動再送を止めてmanual_reviewにします。LINEの受理と端末への到達は別なので、ブロック等による不達は自動検知できません。

各回の送信前にLINEの月間利用状況を確認し、プランの実際の上限と200通の小さい方を超える送信はしません。他の配信も同じ枠を使います。課金プランへの自動変更はありません。エラー時も店舗の投稿・審査には影響しません。

## 停止・確認

即時停止：`update public.line_digest_settings set enabled=false where id;`。またはEdge Function SecretsのLINE_DIGEST_ENABLEDをfalseへ変更。

管理者のSQL Editorで、line_digest_batchesのstate・last_error・created_at・sent_atとcron.job_run_detailsを確認します。テーブルは一般利用者や通常の管理画面から読めません。LINEの鍵を交換する場合はSecretsを更新し、通知先を変更する場合は未確定バッチの旧宛先を先に確認します。宛先が設定と異なるバッチは自動送信しません。

送信済みの通知記録を消すと、まだ審査待ちの投稿が再通知される可能性があります。保存期間を決めずに一括削除しないでください。

## 現在の状態

コード・テスト準備中。LINE公式アカウントの作成とMessaging APIの有効化は本人操作で完了。長期アクセストークンは未発行。011・Edge Function・Cronは本番未反映で、自動通知はまだ動いていません。

参考：[LINE料金](https://developers.line.biz/ja/docs/messaging-api/pricing/)、[再送](https://developers.line.biz/ja/docs/messaging-api/retrying-api-request/)、[自分のユーザーID](https://developers.line.biz/ja/docs/messaging-api/getting-user-ids/)、[Supabase定期実行](https://supabase.com/docs/guides/functions/schedule-functions)。
