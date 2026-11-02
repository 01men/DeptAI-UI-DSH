# 控制台主题可视化依赖

- `three/crystal-three-0.180.0.min.js`：Three.js 0.180.0 官方 npm 包经 esbuild 0.25.12 按场景所需导出裁剪打包（ES module；不包含网络加载器）；许可证见 `three/LICENSE.txt`。仅冰晶场景动态加载，WebGL 不可用时使用内置 SVG，离开页面释放 GPU 资源。

- `cytoscape-3.33.1.min.js`：Cytoscape.js 3.33.1 发布包的 UMD 版；许可证见 `cytoscape-LICENSE.txt`。
- `d3-7.9.0.min.js`：从 D3 7.9.0 依赖树中，仅打包 `select`、`scaleLinear`、`scalePoint`、`max`、`area` 和 `line`，不包含 D3 的网络请求模块；许可证见 `d3-LICENSE.txt` 和 `d3-submodules-LICENSES.txt`。

D3 精简包由 esbuild 0.25.12 生成，入口为：

```js
export { select } from 'd3-selection'
export { scaleLinear, scalePoint } from 'd3-scale'
export { max } from 'd3-array'
export { area, line } from 'd3-shape'
```

构建参数：`--bundle --minify --format=iife --global-name=d3`。具体依赖版本与许可列于 `d3-submodules-LICENSES.txt`。依赖随控制台本地静态资源发布，仅在对应主题按需加载，无 CDN 网络依赖。

Three.js 精简包使用 `esbuild --bundle --minify --format=esm` 并清除着色器字符串行尾空格，入口导出：`WebGLRenderer`、`Scene`、`PerspectiveCamera`、`Group`、`HemisphereLight`、`PointLight`、`MeshPhysicalMaterial`、`MeshStandardMaterial`、`LineBasicMaterial`、`MeshBasicMaterial`、`Mesh`、`Vector3`、`CylinderGeometry`、`EdgesGeometry`、`LineSegments`、`SphereGeometry`、`IcosahedronGeometry`、`TorusGeometry`、`DoubleSide`。
