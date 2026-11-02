/** 冰晶品牌场景：本地 Three.js 按需加载；不把示意连线当作实时业务数据。 */
let library
let sequence = 0

/** SVG 是首帧与 WebGL 不可用时的完整回退，不承载交互或业务文字。 */
export function crystalMarkup() {
  const id = `ice-${++sequence}`
  return `<div class="crystal-scene" data-crystal-scene aria-hidden="true">
    <svg class="crystal-fallback" viewBox="0 0 600 460" focusable="false">
      <defs><linearGradient id="${id}-g" x1="0" y1="0" x2="1" y2="1"><stop stop-color="#e0f8ff"/><stop offset=".38" stop-color="#1679e5" stop-opacity=".3"/><stop offset="1" stop-color="#6ce9ff"/></linearGradient><radialGradient id="${id}-r"><stop stop-color="#d7fcff"/><stop offset=".45" stop-color="#70deff"/><stop offset="1" stop-color="#1678ef" stop-opacity=".15"/></radialGradient></defs>
      <g fill="none" stroke="#55bfff"><ellipse cx="300" cy="373" rx="228" ry="47" opacity=".25"/><ellipse cx="300" cy="373" rx="186" ry="31" opacity=".45"/><path d="M300 35 458 126 458 308 300 399 142 308 142 126Z" stroke="url(#${id}-g)" stroke-width="19"/><path d="M300 53 442 135 442 298 300 380 158 298 158 135Z" stroke="#a7eaff" opacity=".7"/><path d="M300 217 300 96M300 217 196 157M300 217 404 157M300 217 196 278M300 217 404 278M300 217 300 344" stroke="#80e4ff" stroke-width="7"/></g>
      ${[
        [300, 96],
        [196, 157],
        [404, 157],
        [196, 278],
        [404, 278],
        [300, 344],
        [300, 217],
      ]
        .map(
          ([x, y]) =>
            `<g><path d="M${x} ${y - 34}l30 17v34l-30 17-30-17v-34Z" fill="url(#${id}-g)" fill-opacity=".3" stroke="#9be5ff"/><circle cx="${x}" cy="${y}" r="23" fill="url(#${id}-r)"/><circle cx="${x - 5}" cy="${y - 7}" r="5" fill="#fff" opacity=".85"/></g>`,
        )
        .join('')}
    </svg><canvas class="crystal-canvas"></canvas></div>`
}

export function mountCrystalScene(host) {
  const canvas = host?.querySelector('canvas')
  if (host) host.dataset.renderer = 'static'
  let disposed = false,
    renderer,
    scene,
    camera,
    group,
    observer,
    resizeObserver,
    frame = 0
  let visible = true,
    playing = true,
    selected = -1,
    lastFrame = 0
  const nodes = [],
    ownedGeometry = new Set(),
    ownedMaterial = new Set()
  const motion = window.matchMedia?.('(prefers-reduced-motion: reduce)')
  playing = !motion?.matches
  function stopFrame() {
    if (frame) window.cancelAnimationFrame(frame)
    frame = 0
  }
  function destroy() {
    if (disposed) return
    disposed = true
    stopFrame()
    observer?.disconnect()
    resizeObserver?.disconnect()
    document.removeEventListener('visibilitychange', visibility)
    motion?.removeEventListener?.('change', motionChange)
    canvas?.removeEventListener('webglcontextlost', contextLost)
    for (const value of ownedGeometry) value.dispose()
    for (const value of ownedMaterial) value.dispose()
    renderer?.dispose()
    renderer?.forceContextLoss()
    host?.classList.remove('is-webgl')
    if (host) {
      host.dataset.renderer = 'static'
      host.dispatchEvent(new window.Event('crystal-state'))
    }
  }
  function draw(time = 0) {
    frame = 0
    if (disposed || !renderer || !host.isConnected) {
      if (!host?.isConnected) destroy()
      return
    }
    if (visible && !document.hidden && time - lastFrame > 32) {
      lastFrame = time
      group.rotation.y = 0.2 + (playing ? Math.sin(time * 0.00018) * 0.18 : 0)
      group.position.y = playing ? Math.sin(time * 0.0006) * 0.06 : 0
      renderer.render(scene, camera)
    }
    if (playing && visible && !document.hidden)
      frame = window.requestAnimationFrame(draw)
  }
  function refresh() {
    stopFrame()
    if (!renderer || disposed) return
    lastFrame = -Infinity
    draw(performance.now())
  }
  function visibility() {
    refresh()
  }
  function motionChange() {
    playing = !motion.matches
    refresh()
  }
  function contextLost(event) {
    event.preventDefault()
    destroy()
  }
  const api = {
    destroy,
    focus(index) {
      selected = index
      nodes.forEach((node, i) => {
        node.scale.setScalar(i === index ? 1.35 : 1)
        node.material.color.setHex(i === index ? 0xffffff : 0x81dcff)
      })
      refresh()
    },
    setMotion(value) {
      playing = value && !motion?.matches
      refresh()
      return playing
    },
  }
  if (!canvas || !window.WebGL2RenderingContext) return api
  async function start() {
    try {
      library ||= import('../vendor/three/crystal-three-0.180.0.min.js').catch(
        (error) => {
          library = null
          throw error
        },
      )
      const T = await library
      if (disposed || !host.isConnected) return
      const context = canvas.getContext('webgl2', {
        alpha: true,
        antialias: true,
        powerPreference: 'low-power',
      })
      if (!context) return
      renderer = new T.WebGLRenderer({
        canvas,
        context,
        alpha: true,
        antialias: true,
      })
      renderer.setPixelRatio(Math.min(window.devicePixelRatio || 1, 1.5))
      renderer.setClearColor(0x000000, 0)
      scene = new T.Scene()
      camera = new T.PerspectiveCamera(38, 1, 0.1, 50)
      camera.position.set(0, 0.4, 8.7)
      camera.lookAt(0, -0.1, 0)
      group = new T.Group()
      scene.add(group)
      scene.add(new T.HemisphereLight(0xd9faff, 0x0b225b, 2.4))
      for (const [x, y, z, color, intensity] of [
        [-3, 4, 5, 0xd8f5ff, 28],
        [4, 1, 2, 0x147bff, 23],
        [0, -3, 3, 0x32d9ff, 15],
      ]) {
        const light = new T.PointLight(color, intensity, 20)
        light.position.set(x, y, z)
        scene.add(light)
      }
      const geometry = (g) => {
        ownedGeometry.add(g)
        return g
      }
      const material = (m) => {
        ownedMaterial.add(m)
        return m
      }
      const glass = material(
        new T.MeshPhysicalMaterial({
          color: 0x2682d9,
          metalness: 0.35,
          roughness: 0.15,
          transparent: true,
          opacity: 0.5,
          clearcoat: 1,
          side: T.DoubleSide,
        }),
      )
      const edgeMat = material(
        new T.LineBasicMaterial({
          color: 0x9ce9ff,
          transparent: true,
          opacity: 0.85,
        }),
      )
      const glow = material(
        new T.MeshBasicMaterial({
          color: 0x56d7ff,
          transparent: true,
          opacity: 0.85,
        }),
      )
      function mesh(g, m, parent = group) {
        const object = new T.Mesh(geometry(g), m)
        parent.add(object)
        return object
      }
      function crystal(g) {
        const object = mesh(g, glass)
        object.add(
          new T.LineSegments(
            geometry(new T.EdgesGeometry(object.geometry)),
            edgeMat,
          ),
        )
        return object
      }
      function beam(a, b, radius, mat) {
        const start = new T.Vector3(...a),
          end = new T.Vector3(...b),
          delta = end.clone().sub(start)
        const object = mesh(
          new T.CylinderGeometry(radius, radius, delta.length(), 6),
          mat,
        )
        object.position.copy(start.add(end).multiplyScalar(0.5))
        object.quaternion.setFromUnitVectors(
          new T.Vector3(0, 1, 0),
          delta.normalize(),
        )
        return object
      }
      const points = Array.from({ length: 6 }, (_, i) => {
        const a = Math.PI / 2 + (i * Math.PI) / 3
        return [Math.cos(a) * 1.95, Math.sin(a) * 1.95, 0]
      })
      points.forEach((p, i) => {
        beam(p, points[(i + 1) % 6], 0.115, glass)
        beam(
          [p[0], p[1], 0.12],
          [points[(i + 1) % 6][0], points[(i + 1) % 6][1], 0.12],
          0.012,
          glow,
        )
        const inner = p.map((v) => v * 0.75)
        beam([0, 0, 0.08], inner, 0.027, glow)
        const shell = crystal(new T.CylinderGeometry(0.38, 0.38, 0.26, 6))
        shell.rotation.x = Math.PI / 2
        shell.position.set(...inner)
        const orb = mesh(
          new T.SphereGeometry(0.19, 24, 16),
          material(
            new T.MeshStandardMaterial({
              color: 0x81dcff,
              emissive: 0x0870ce,
              emissiveIntensity: 0.8,
              metalness: 0.3,
              roughness: 0.15,
            }),
          ),
        )
        orb.position.set(inner[0], inner[1], 0.15)
        nodes.push(orb)
      })
      const core = mesh(
        new T.IcosahedronGeometry(0.4, 1),
        material(
          new T.MeshStandardMaterial({
            color: 0xbef3ff,
            emissive: 0x258dd9,
            emissiveIntensity: 0.45,
            metalness: 0.25,
            roughness: 0.12,
          }),
        ),
      )
      core.position.z = 0.1
      for (const r of [2.25, 2.65]) {
        const ring = mesh(new T.TorusGeometry(r, 0.016, 8, 96), glow, scene)
        ring.rotation.x = Math.PI / 2
        ring.position.y = -2.12
      }
      function resize() {
        if (disposed) return
        const width = host.clientWidth || 500,
          height = host.clientHeight || 400
        camera.aspect = width / height
        camera.updateProjectionMatrix()
        renderer.setSize(width, height, false)
        refresh()
      }
      canvas.addEventListener('webglcontextlost', contextLost)
      document.addEventListener('visibilitychange', visibility)
      motion?.addEventListener?.('change', motionChange)
      if (window.ResizeObserver) {
        resizeObserver = new window.ResizeObserver(resize)
        resizeObserver.observe(host)
      }
      if (window.IntersectionObserver) {
        observer = new window.IntersectionObserver(([entry]) => {
          visible = entry.isIntersecting
          refresh()
        })
        observer.observe(host)
      }
      api.focus(selected)
      resize()
      host.classList.add('is-webgl')
      host.dataset.renderer = 'webgl'
      host.dispatchEvent(new window.Event('crystal-state'))
    } catch {
      destroy() /* 首帧静态冰晶继续可见，页面导航与数据不依赖 GPU。 */
    }
  }
  void start()
  return api
}
