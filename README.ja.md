[English](./README.md) | [简体中文](./README.zh-CN.md) | [日本語](./README.ja.md) | [한국어](./README.ko.md) | [Español](./README.es.md) | [Français](./README.fr.md) | [Deutsch](./README.de.md)

# Codex RouteSync

**保存済みの Codex アカウントと Responses 互換 API プロバイダーをシームレスに切り替え、どちらのモードでもローカル会話履歴を共有し、選択項目ごとのローカルトークン使用量を確認できます。**

Codex RouteSync は、認証情報とプロバイダールーティングを 1 回の保護された切り替え処理で更新します。アカウントモードと互換 API プロバイダーモードは同じローカル履歴領域を使うため、Codex の認証方法を変更しても新しい会話が別々のタイムラインに分かれません。

VS Code 拡張機能は、現在のモード、共有履歴の状態、アカウントクォータのリセット時刻、ローカルトークンの合計使用量を表示するグラフィカルなダッシュボードをエディター領域に開きます。保存済みアカウントと API プロバイダーは 1 つのフラットなルート一覧に並びます。トークン詳細にはソース別ドーナツグラフがあり、オレンジ色の履歴グラフはローカル観測値を日、週、月単位で集計します。ダッシュボードは VS Code の表示言語に追従するほか、英語と簡体字中国語をすぐに切り替えられます。

## 使用イメージ

アクティビティバーの **Codex RouteSync** を開くと、保存済みアカウントと API プロバイダーが同じ階層に並ぶフラットな **Accounts & API Routes** 一覧が表示され、ダッシュボードが自動的に開くか前面に移動します。アカウントや API の管理にはルート一覧を使い、クォータ、リセット時刻、自動切り替え、ローカルトークン履歴の確認には広いダッシュボードを使います。

![英語のダークテーマで表示した Codex RouteSync ダッシュボード](./assets/screenshots/dashboard-en-dark.png)

同じダッシュボードを簡体字中国語へすぐに切り替えられます。

![簡体字中国語のライトテーマで表示した Codex RouteSync ダッシュボード](./assets/screenshots/dashboard-zh-light.png)

Codex RouteSync は Windows、macOS、Linux で動作します。VS Code またはコマンドラインから利用できます。

[![GitHub リリース](https://img.shields.io/github/v/release/ShawBob001/codex-routesync)](https://github.com/ShawBob001/codex-routesync/releases)
[![Visual Studio Marketplace](https://img.shields.io/badge/VS%20Code%20Marketplace-install-007ACC)](https://marketplace.visualstudio.com/items?itemName=ShawBob001.codex-routesync)
[![ライセンス: MIT](https://img.shields.io/badge/license-MIT-blue.svg)](./LICENSE)

## 2 つのモード、1 つのローカル会話履歴

```text
Codex アカウントモード  <->  Codex RouteSync  <->  Responses API プロバイダーモード
                               |
                       CODEX_HOME 内の共有履歴
```

| 機能 | RouteSync の動作 |
| --- | --- |
| アカウントと API の切り替え | 選択したアカウント認証情報または API プロバイダープロファイルを、対応する Codex 設定と一緒に適用します |
| 会話履歴の共有 | 1 つの Codex 履歴領域を使い、両方のモードから新しいローカルスレッドを参照できるようにします |
| ローカルトークン使用量 | Codex の rollout カウンターをローカルで索引化し、日次、週次、月次のアクティビティをグラフ化して、保存済みアカウントまたは API プロバイダーごとに集計します |
| 状態の保持 | 次のモードを適用する前に、切り替え元のアカウントまたはプロバイダーの認証情報を保存します |
| 安全な切り替え | 同時に発生した切り替えを直列化し、認証情報をアトミックに書き込み、ロールバック用バックアップを保持します |
| 再読み込みの処理 | Codex 拡張機能が新しい認証状態を読み込む必要がある場合、既定で操作を妨げない再読み込みアクションを表示します |

> 共有会話履歴は 1 つの `CODEX_HOME` 内だけで有効です。ChatGPT の Web 履歴、Codex Cloud タスク、コネクター、クォータ、端末間の会話履歴をコピーまたは統合する機能ではありません。

## クイックスタート

### VS Code 拡張機能

[Visual Studio Marketplace のページ](https://marketplace.visualstudio.com/items?itemName=ShawBob001.codex-routesync)から拡張機能をインストールするか、VS Code の拡張機能ビューで `Codex RouteSync` を検索してください。

オフラインでインストールする場合は、[GitHub Releases](https://github.com/ShawBob001/codex-routesync/releases) から最新の `.vsix` をダウンロードし、**Extensions: Install from VSIX...** を実行します。ターミナルでは次のコマンドを使えます。VERSION はダウンロードしたファイル名のバージョンに置き換えてください。

```bash
code --install-extension codex-routesync-VERSION.vsix
```

#### 以前の Marketplace 版から移行する

以前の Marketplace 版から Codex SwitchBridge をインストールした場合は、まず以前のインストールを開き、同期またはクラウドにあるすべてのアカウントと API プロバイダーを **Local** に移動します。次に、以前のインストールを無効化またはアンインストールし、**Developer: Reload Window** を実行してから、上記のリンクで Codex RouteSync をインストールし、ストレージパスワードを再入力します。

設定済みの `CODEX_HOME` にあるアカウント、API プロバイダー、設定ファイル、バックアップ、共有履歴は引き続き利用でき、既存の `codex-switchbridge.*` 設定もそのまま有効です。2 つの版は拡張機能 ID が異なるため、以前のインストールの `globalState`、`SecretStorage`、保存済みのルート別使用量割り当ては自動的に移行されません。

アクティビティバーの **Codex RouteSync** ビューを開きます。フラットな **Accounts & API Routes** 一覧では、保存済みアカウントと API プロバイダーがサイドバーの同じディレクトリに並びます。ダッシュボードは中央のエディター領域で自動的に開くか前面に戻ります。タイトルバーの **Open Dashboard** アクションも予備の入口として利用できます。

### CLI

GitHub リリースから CLI の tarball をインストールします。

```bash
npm install --global ./codex-switchbridge-cli-0.3.0.tgz
codex-switchbridge --version
```

npm への公開後は、同じパッケージをレジストリからインストールできます。

```bash
npm install --global codex-switchbridge-cli
```

## アカウントと API プロバイダーの切り替え

VS Code では **Switch Account** または **Switch API Provider** を使います。RouteSync は現在の選択を保存し、`auth.json` と `config.toml` を更新してから、アカウントとプロバイダーのビューを更新します。

CLI から操作する場合:

```bash
# 保存済みの Codex アカウントへ切り替える
codex-switchbridge use work

# 保存済みの Responses 互換 API プロバイダーへ切り替える
# 共有ローカル履歴は既定で有効
codex-switchbridge mode team-api

# 互換性のために必要な場合はプロバイダー固有の履歴を保持する
codex-switchbridge mode team-api --separate-history
```

名前付きアカウントへ戻るには `codex-switchbridge use <name>` を使います。`mode account` が保存済みアカウントを 1 つだけ特定できた場合は、そのアカウントを復元します。複数のアカウントがある場合、CLI は推測せず、`use <name>` で選択するよう求めます。

API プロバイダープロファイルには、`auth.json` 用の認証ペイロードと `config.toml` 用のプロバイダー設定が保存されます。共有履歴を使うには `wire_api = "responses"` と有効なプロバイダー `base_url` が必要です。

## エディターダッシュボード、クォータのリセット時刻、ローカルトークン使用量

VS Code ダッシュボードは、現在の `CODEX_HOME` にあるローカル Codex rollout ファイルからアカウントクォータのメタデータと累積 `token_count` イベントを読み取ります。次の情報を表示します。

- アカウントサービスが返した各クォータ枠の残り割合。5 時間、7 日間、名前付き制限を含みます。
- 利用可能な各クォータリセットの秒単位ライブカウントダウン
- 同じリセット時刻のローカル時刻表示。秒とタイムゾーンオフセットを含みます。
- 上流から返された正確な UTC タイムスタンプ。存在する場合はミリ秒も含みます。
- アカウントサービスから提供された場合、獲得済みで利用可能なレート制限リセット回数
- 現在のアカウントに獲得済みリセットがある場合、確認付きの **Use one reset** アクション
- 記録済みの合計、入力、出力、キャッシュ入力、推論出力トークン
- 帰属済みと未帰属の合計
- アカウントおよび API プロバイダーごとの使用量とセッション数
- アカウント、API プロバイダー、未帰属の互いに重複しない合計を比較するソース別ドーナツグラフ
- ソースと日付で絞り込めるオレンジ色の日次、週次、月次使用量グラフ
- 選択範囲の合計、平均、ピーク、推定使用量
- インデックスの対象範囲、セッション数、追跡開始時刻、最終更新時刻

リセット時計はクォータサービスが返す絶対タイムスタンプを優先します。相対カウントダウンしかない場合、RouteSync は問い合わせ時に対応するタイムスタンプを算出します。欠落、不正、または期限を過ぎたリセットメタデータは明示されます。カウントダウンは実時間から再計算されるため、ダッシュボード全体を更新せずに変化します。アカウントクォータの取得と OAuth トークン更新では、最初に `codex-switchbridge.proxy`、次に VS Code の `http.proxy`、最後に拡張機能ホストの `HTTPS_PROXY`、`HTTP_PROXY`、`ALL_PROXY` 環境変数を使います。環境変数の解決では引き続き `NO_PROXY` が尊重されます。専用設定は端末固有で、Settings Sync の対象外です。VS Code は値をローカル設定に保存するため、認証不要のローカルプロキシを使うか、URL に認証情報が含まれる場合は端末設定ファイルを保護してください。

ダッシュボード上部の言語セレクターでは **Auto**、**English**、**简体中文** を選べます。Auto は VS Code の表示言語に従います。明示的な選択はウィンドウ設定として保存され、VS Code を再読み込みせずに反映されます。

リセット操作は公式の Codex App Server メソッドを使います。同じ保存済みアカウントが有効なままであることを確認してからユーザーに確認を求め、冪等性キーを付けて獲得済みリセットを最大 1 回分だけ使用し、その後クォータを更新します。インストール済みの Codex がリセット消費に対応していない場合、RouteSync は代わりに公式 Usage ページを開きます。

記録済み合計は入力と出力から構成されます。キャッシュ入力は入力に、推論出力は出力にすでに含まれているため、この 2 つを再び加算することはありません。ドーナツグラフには互いに重複しない帰属済みソース合計だけを使うため、キャッシュ入力や推論出力を二重計上しません。

選択項目ごとの帰属は、RouteSync がローカル追跡を始めた時点から記録されます。以後、インデックスは Codex がトークン増分を記録した時点で有効だったアカウントまたは API プロバイダーに、その増分を割り当てます。1 つの会話がモード切り替えをまたいだ場合も同様です。以前の共有 `openai` セッションは、特定の保存済み項目へ安全に割り当てられないため、**Earlier or unattributed** に残ります。以前のプロバイダータグ付きセッションは、そのプロバイダー ID が保存済みプロファイル 1 つだけに対応する場合に限り割り当てられます。

アカウントサービスが返すのは残り割合であり、残りトークンの絶対数ではありません。履歴グラフは端末上のローカルアクティビティカウンターであり、請求、料金、リモート残高を表すものではありません。正確な日時を特定できない過去の索引済みアクティビティは推定として表示され、信頼できる日付がないものはグラフに入りません。API プロバイダープロファイルは、そのプロバイダーに互換クォータ API がある場合を除き、ローカルカウンターだけを表示します。RouteSync は rollout の内容をアップロードしません。ローカルインデックスが保存するのはカウンター、タイムスタンプ、ファイル指紋、不透明 ID です。会話本文、パス、アカウントラベル、プロバイダー名、認証情報は保存しません。すぐに再索引するには **Refresh Local Token Usage** を使います。それ以外の場合は通常のバックグラウンドメンテナンス中に更新されます。

## 会話履歴が利用可能な状態を保つ仕組み

Codex は通常、ローカルスレッドをモデルプロバイダーごとに分類します。カスタムプロバイダー ID を使うと、ファイルが残っていても、アカウントモードへ戻った際にスレッドが消えたように見えることがあります。

RouteSync は新しいスレッドが分離しないようにします。

1. アカウントモードは Codex 組み込みの `openai` プロバイダーを使います。
2. Responses 互換 API プロバイダーは同じ履歴 ID を維持し、RouteSync が API キーとベース URL を適用します。
3. 元に戻すと、アカウント認証情報と本来の OpenAI ルートが復元されます。

このため、両方のモードが同じ `CODEX_HOME` にある同じローカル会話履歴を読み取ります。RouteSync が同期するのは履歴の索引に使われるルートです。切り替えるたびに会話本文をコピーするわけではありません。

VS Code 拡張機能と互換 CLI プロバイダー切り替えでは、共有履歴が既定で有効です。VS Code では `codex-switchbridge.shareHistoryAcrossProviders` で制御できます。

### 以前のプロバイダータグ付きスレッドを修復する

共有ルーティングを使う前に作られたスレッドには、プロバイダー固有 ID が残っている場合があります。それらを共有ローカル履歴へ移す手順は次のとおりです。

1. 実行中の Codex 出力を停止します。
2. **Codex RouteSync: Repair Shared Conversation History** を実行します。
3. 修復が完了したら、ステータスバーの **Reload recommended** アクションを使います。

修復コマンドはバックアップを作成し、プロバイダー ID のフィールドだけを変更して、JSONL と SQLite のレコードを検証します。検査中に rollout が変更された場合は停止します。拡張機能の起動時に履歴が書き換えられることはありません。Python 3 が必要なのはこのメンテナンスコマンドだけです。

正確な対象範囲と安全確認については、[モード間の会話履歴](./docs/shared-history.md)を参照してください。

## 機能

- VS Code でローカルまたは同期済みの Codex アカウントと API プロバイダーをワンクリックで切り替え
- 保存済みアカウントと API プロバイダーが同じ階層に並ぶフラットなサイドバールート一覧
- CLI から 1 コマンドでアカウントと API プロバイダーを切り替え
- Responses 互換プロバイダールートでローカル会話履歴を共有
- グラフィカルなクォータ、正確なリセット時計、獲得済みリセットの使用、ソース別ドーナツグラフ、日次、週次、月次で絞り込めるローカルトークン履歴を備えた広いエディターダッシュボード
- ダッシュボードで英語と簡体字中国語を実行中に切り替え、VS Code のコマンドと設定もローカライズ
- アカウントクォータ表示、トークン更新、ローテーション式バックグラウンドメンテナンス
- 保存済みアカウントとプロバイダーをローカルまたは VS Code Settings Sync に保存
- 保存済み認証データの任意暗号化
- 保存済みアカウントのインポートとエクスポート
- 以前のプロバイダータグ付きローカルスレッドをバックアップ後に修復
- ウィンドウをまたぐ切り替えロックとロールバックスナップショット

## CLI コマンド

| コマンド | 説明 |
| --- | --- |
| `codex-switchbridge add <name>` | `codex login` を実行し、結果を名前付きアカウントとして保存します |
| `codex-switchbridge list` | 保存済みアカウントと API プロバイダーを一覧表示します |
| `codex-switchbridge use <name>` | 保存済みアカウントへ切り替え、アカウントモードを復元します |
| `codex-switchbridge mode [name]` | 現在のモードを表示するか、既定で共有履歴を使う API プロバイダーへ切り替えます |
| `codex-switchbridge mode <name> --separate-history` | プロバイダー固有のローカル履歴を使う API プロバイダーへ切り替えます |
| `codex-switchbridge remove <name>` | 保存済みアカウントを削除します |
| `codex-switchbridge quota [name]` | アカウントのクォータ使用量を表示します |
| `codex-switchbridge current` | 現在のアカウントまたは API プロバイダーモードを表示します |
| `codex-switchbridge refresh [name]` | アカウントのアクセストークンを更新します |
| `codex-switchbridge export [file]` | 保存済みアカウントを JSON にエクスポートします |
| `codex-switchbridge import <file>` | JSON ファイルから保存済みアカウントをインポートします |

保存済み項目を既定の Codex ディレクトリ以外へ置くには `--auth-dir <path>` または `CODEX_SWITCHBRIDGE_AUTH_DIR` を使います。暗号化された項目のロックを解除するには `--password` または `CODEX_SWITCHBRIDGE_PASSWORD` を使います。

## VS Code の設定

| 設定 | 既定値 | 説明 |
| --- | --- | --- |
| `codex-switchbridge.language` | `auto` | VS Code に従うか、ダッシュボードで英語または簡体字中国語を使います |
| `codex-switchbridge.proxy` | `""` | アカウントクォータ取得と OAuth トークン更新に使う端末固有の HTTP(S) プロキシです。Settings Sync の対象外です。空の場合は VS Code と拡張機能ホストのプロキシ設定を使います |
| `codex-switchbridge.shareHistoryAcrossProviders` | `true` | アカウントモードと互換 API プロバイダーモードで新しいローカル会話履歴を共有します |
| `codex-switchbridge.reloadWindowAfterSwitch` | `statusBar` | 切り替え後に再読み込みアクションを表示するか、通知しないか、自動で再読み込みするかを指定します |
| `codex-switchbridge.quotaRefreshInterval` | `30` | トークン保守とクォータ更新のため、間隔ごとに保存済みアカウントを 1 つ確認します |
| `codex-switchbridge.tokenAutoUpdate` | `true` | 保存済みアカウントのトークンが期限切れ、または期限間近の場合、バックグラウンドメンテナンス中に更新します |
| `codex-switchbridge.showStatusBar` | `true` | 現在の選択、クォータ、トークン使用量、再読み込みの推奨をステータスバーに表示します |
| `codex-switchbridge.authDirectory` | `""` | ローカルの保存済み項目をこのディレクトリに置きます。空の場合は既定の Codex ディレクトリを使います |

## データと切り替えの安全性

ローカルアカウントは `auth_{name}.json`、ローカル API プロバイダーは `provider_{name}.json` を使います。VS Code では暗号化された項目を同期拡張機能ストレージに保存することもできます。

切り替えで有効な `auth.json` を上書きする前に、RouteSync は切り替え元の最新認証情報を、対応する保存済みアカウントまたはプロバイダーへ書き戻します。その後、1 つのプロセス間ロックの中で認証、プロバイダールーティング、共有履歴ルートの状態を更新します。認証ファイルはアトミックに置き換えられ、切り替えに失敗した場合はスナップショットから復元されます。

クォータ参照とローカルトークン索引は読み取り専用です。トークンのローテーション、保存済み認証情報の書き換え、会話ファイルの変更は行いません。トークン保守は別の処理です。

一部の Codex ツールは起動時に認証情報をキャッシュします。RouteSync は別の拡張機能プロセスにそのキャッシュを破棄させることができません。そのため、ファイル切り替えが成功した後でも VS Code ウィンドウの再読み込みが必要になる場合があります。既定の動作ではポップアップを何度も表示せず、この推奨をステータスバーに残します。

**Codex Account Switch** と Codex RouteSync を同時に実行しないでください。どちらの拡張機能も同じローカル Codex ファイルへ書き込みます。

## 開発

```bash
npm install
npm run build
npm run verify
```

ダッシュボードのビジュアルテストには Playwright Chromium と Linux のシステム依存関係も必要です。

```bash
npx playwright install --with-deps chromium
npm run test:visual -w packages/vscode
```

`/etc/fonts/fonts.conf` がない最小 Linux イメージでは、`FONTCONFIG_FILE` と `FONTCONFIG_PATH` から有効な Fontconfig 設定を参照できるようにしてください。設定がなければ Chromium は文字を測定または描画できません。

プロジェクト構成:

```text
packages/
  core/     認証、プロバイダーと履歴のルーティング、クォータ、ストレージの共有ロジック
  cli/      コマンドラインインターフェース
  vscode/   VS Code 拡張機能
scripts/    履歴メンテナンスとリリース補助ツール
docs/       アーキテクチャ、動作、デプロイに関する文書
```

リリース手順は[デプロイ](./docs/deployment.md)に記載されています。

## 来歴とライセンス

Codex RouteSync は [jqknono/codex-account-switch](https://github.com/jqknono/codex-account-switch) から派生した独立オープンソースプロジェクトで、`ShawBob001` による大幅な変更が加えられています。

[MIT License](./LICENSE) の下で公開されています。上流の著作権表示とライセンス本文は保持されています。
