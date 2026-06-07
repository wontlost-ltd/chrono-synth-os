/** 加载 / 错误 / 鉴权失败的统一占位块。 */
export function StateBlock(props: {
  status: 'loading' | 'ok' | 'error';
  error?: string;
  authError?: boolean;
}): JSX.Element {
  if (props.status === 'loading') {
    return <div className="state state--loading">加载中…</div>;
  }
  if (props.authError) {
    return (
      <div className="state state--auth">
        <p>{props.error ?? '请先登录'}</p>
        <p className="muted">个人版账号登录后即可查看你的数字人。</p>
      </div>
    );
  }
  return <div className="state state--error">出错了：{props.error ?? '未知错误'}</div>;
}
