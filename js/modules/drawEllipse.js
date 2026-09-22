/**
 * 画椭圆模块（js/modules/drawEllipse.js）
 * 三点确定椭圆：左键点击第一点定圆心 → 第二点定长半轴（长度 + 方向）→ 第三点定短半轴（方向自动垂直长轴）完成。
 * 通过 ctx（Draw 实例）调用公共工具方法，与 drawRect / drawCircle 等模块结构一致。
 *
 * 避坑说明（与既有模块一致）：
 * - 绘制前先 ctx.stopEditing() 清理遗留 handler
 * - 实体属性全部用 CallbackProperty（基于 points + tempPoint），绘制预览 / 完成固定 / 编辑拖拽全程自动更新
 * - id 冲突时先移除旧实体再创建
 *
 * @param {object} ctx - Draw 实例（this）
 * @param {object} options - 画椭圆参数
 * @param {string} [options.id] - 自定义实体 id（可选，不传则由 Cesium 自动生成）
 * @param {object} [options.style] - 样式（lineWidth / color / pointSize / clampToGround）
 * @param {Function} [options.success] - 绘制完成回调，返回 { id, positions, type }
 */
export default function drawEllipse(ctx, { id, style = {}, success }) {
  // 避坑：开始新绘制前，退出可能存在的编辑状态并销毁遗留 handler
  ctx.stopEditing();

  const shape = {
    type: "ellipse",
    id, // 用户自定义实体 id（可选）
    points: [], // [圆心, 长半轴点, 短半轴点]
    tempPoint: null, // 跟随鼠标的点（预览）
    mainEntity: null, // 椭圆实体（EllipseGraphics）
    pointsEntity: [], // 圆心 / 长半轴点 / 短半轴点实体（编辑拖拽用）
    success, // 完成回调
    style: {
      lineWidth: style.lineWidth ?? ctx.config.lineWidth,
      color: style.color ?? ctx.config.color,
      pointSize: style.pointSize ?? ctx.config.pointSize,
      clampToGround: style.clampToGround ?? ctx.config.clampToGround,
    },
  };
  ctx.activeShape = shape;

  // 避坑：传了 id 且已存在时，先移除旧实体（含 shapes 数据），覆盖创建
  if (shape.id && ctx._entities.getById(shape.id)) {
    console.warn(`实体 id "${shape.id}" 已存在，旧实体将被移除`);
    const oldShape = ctx.shapes.find((s) => s.mainEntity.id === shape.id);
    if (oldShape) {
      ctx.removeShape(oldShape);
    } else {
      ctx._entities.removeById(shape.id);
    }
  }

  // 两点距离（米）
  const dist = (a, b) => {
    const ca = Cesium.Cartesian3.fromDegrees(a[0], a[1]);
    const cb = Cesium.Cartesian3.fromDegrees(b[0], b[1]);
    return Cesium.Cartesian3.distance(ca, cb);
  };
  // 长轴方向角（从正东逆时针，弧度；Cesium rotation 即此定义）
  const heading = (a, b) => {
    const dLon = (b[0] - a[0]) * Cesium.Math.toRadians(1);
    const dLat = (b[1] - a[1]) * Cesium.Math.toRadians(1);
    const cosLat = Math.cos(Cesium.Math.toRadians(a[1]));
    return Math.atan2(dLat, dLon * cosLat);
  };
  // 圆心（未定则用原点兜底）
  const center = () => shape.points[0] || [0, 0];
  // 长半轴点（未定则用鼠标位置，鼠标未动则退化为圆心）
  const longPoint = () =>
    shape.points[1] || shape.tempPoint || shape.points[0] || [0, 0];
  // 短半轴点（未定则用鼠标位置或长轴点）
  const shortPoint = () =>
    shape.points[2] ||
    shape.tempPoint ||
    shape.points[1] ||
    shape.points[0] || [0, 0];

  // 主实体：椭圆，全部属性 CallbackProperty 自动更新
  shape.mainEntity = ctx.createEllipseEntity([0, 0], shape.style, {
    id: shape.id,
    position: () => Cesium.Cartesian3.fromDegrees(center()[0], center()[1]),
    semiMajorAxis: () => dist(center(), longPoint()),
    semiMinorAxis: () => dist(center(), shortPoint()),
    rotation: () => heading(center(), longPoint()),
  });

  // 加点：圆心 / 长半轴点 / 短半轴点实体（画线样式：小号、无白边）
  const addPoint = (lonlat) => {
    const entity = ctx.createPointEntity(lonlat, {
      size: Math.max(shape.style.pointSize - 4, 4),
      color: shape.style.color,
      outline: false,
      clampToGround: shape.style.clampToGround,
    });
    shape.pointsEntity.push(entity);
    return entity;
  };

  // 完成绘制
  const finish = () => {
    if (shape.points.length < 3) {
      // 半轴未定完整，整个椭圆作废
      ctx._entities.remove(shape.mainEntity);
      shape.pointsEntity.forEach((item) => {
        ctx._entities.remove(item);
      });
      console.warn("椭圆需要圆心、长半轴点、短半轴点三个点");
      ctx.activeShape = null;
      ctx.destroy();
      return;
    }
    shape.tempPoint = null; // 固定最终半轴（CallbackProperty 自动落到最终值）
    ctx.completeShape(shape);
  };
  // 供 drawTool.stopDraw() 调用（预留，停止绘制直接清理，不触发完成）
  shape.finish = finish;

  ctx.handler = new Cesium.ScreenSpaceEventHandler(ctx.viewer.scene.canvas);
  // 监听鼠标移动：更新预览 + 显示坐标标签
  ctx.handler.setInputAction((e) => {
    const lonlat = ctx.pickLonLat(e.endPosition);
    if (!lonlat) {
      ctx.removeLabel();
      return; // 如果没有点击到地面，返回
    }
    ctx.addLabel(
      Cesium.Cartesian3.fromDegrees(lonlat[0], lonlat[1]),
      `左键点击：圆心 → 长半轴 → 短半轴，右键撤销\n经度：${lonlat[0]}°\n纬度：${lonlat[1]}°`,
    );
    if (shape.points.length > 0) {
      shape.tempPoint = lonlat; // 预览半轴
    }
  }, Cesium.ScreenSpaceEventType.MOUSE_MOVE);

  // 监听左键点击：依次定圆心、长半轴点、短半轴点
  ctx.handler.setInputAction((e) => {
    const lonlat = ctx.pickLonLat(e.position);
    if (!lonlat) return; // 如果没有点击到地面，返回
    if (shape.points.length > 0) {
      const last = shape.points[shape.points.length - 1];
      if (last[0] === lonlat[0] && last[1] === lonlat[1]) return;
    }
    shape.points.push(lonlat);
    addPoint(lonlat);
    ctx.emit("drawAddPoint", ctx._shapeResult(shape));
    if (ctx.activeShape !== shape) return;
    if (shape.points.length >= 3) {
      finish(); // 短半轴点确定，完成
    }
  }, Cesium.ScreenSpaceEventType.LEFT_CLICK);

  // 监听右键点击：撤销最后一个点（短半轴点 → 长半轴点 → 圆心 → 无）
  ctx.handler.setInputAction((e) => {
    if (shape.points.length === 0) return; // 没有点可撤销
    ctx._entities.remove(shape.pointsEntity.pop());
    shape.points.pop();
    if (shape.points.length > 0) {
      // 回到上一个状态，预览基于当前鼠标位置重绘
      const lonlat = ctx.pickLonLat(e.position);
      if (lonlat) {
        shape.tempPoint = lonlat;
      }
    } else {
      shape.tempPoint = null; // 圆心也撤销了，椭圆消失
    }
    ctx.emit("drawRemovePoint", ctx._shapeResult(shape));
  }, Cesium.ScreenSpaceEventType.RIGHT_CLICK);
  ctx._emitDrawStart(shape);
}
