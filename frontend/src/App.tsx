import Home from "./pages/Home";
import Settings from "./pages/Settings";

// 只有构建记录和设置两个页面，用路径区分即可，不引入路由库。顶栏的“设置”链接到 /apps/builder/settings/。
export default function App() {
  return location.pathname.startsWith("/apps/builder/settings") ? <Settings /> : <Home />;
}
