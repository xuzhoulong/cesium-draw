/**
 * 画点模块（js/modules/drawPoint.js）
 * 单击放置一个点；鼠标移动时显示预览点（半透明小点）跟随。
 * 通过 ctx（Draw 实例）调用公共工具方法，与 drawLine 模块结构一致。
 *
 * @param {object} ctx - Draw 实例（this）
 * @param {object} options - 画点参数
 * @param {string} [options.id] - 自定义实体 id（可选，不传则由 Cesium 自动生成）
 * @param {object} [options.style] - 样式（lineWidth / color / pointSize）
 * @param {Function} [options.success] - 绘制完成回调，返回 { id, positions, type }
 */
export default function drawPoint(ctx, { id, style = {}, success }) {
  // 开始新绘制前，退出可能存在的编辑状态并销毁遗留 handler
  ctx.stopEditing();

  const shape = {
    type: "point",
    id, // 用户自定义实体 id（可选）
    points: [], // 坐标数组 [[lon, lat]]
    mainEntity: null, // 正式点实体
    tempEntity: null, // 预览点实体（跟随鼠标）
    pointsEntity: [], // 编辑用点实体数组（画点暂不参与顶点拖拽）
    success, // 完成回调
    style: {
      lineWidth: style.lineWidth ?? ctx.config.lineWidth,
      color: style.color ?? ctx.config.color,
      pointSize: style.pointSize ?? ctx.config.pointSize,
    },
  };
  ctx.activeShape = shape;

  // 预览点：跟随鼠标（小号、无描边），初始位置在原点并隐藏
  shape.tempEntity = ctx.createPointEntity([0, 0], {
    size: Math.max(shape.style.pointSize - 4, 4),
    color: shape.style.color,
    outline: false,
  });
  shape.tempEntity.show = false;

  ctx.handler = new Cesium.ScreenSpaceEventHandler(ctx.viewer.scene.canvas);
  // 监听鼠标移动：更新预览点位置 + 显示坐标标签
  ctx.handler.setInputAction((e) => {
    const lonlat = ctx.pickLonLat(e.endPosition);
    if (!lonlat) {
      // 未命中地面：隐藏预览点
      shape.tempEntity.show = false;
      ctx.removeLabel();
      return;
    }
    shape.tempEntity.show = true;
    shape.tempEntity.position.setValue(
      Cesium.Cartesian3.fromDegrees(lonlat[0], lonlat[1]),
    );
    ctx.addLabel(
      Cesium.Cartesian3.fromDegrees(lonlat[0], lonlat[1]),
      `左键放置点\n经度：${lonlat[0]}°\n纬度：${lonlat[1]}°`,
    );
  }, Cesium.ScreenSpaceEventType.MOUSE_MOVE);

  // 监听左键点击：放置点，完成绘制
  ctx.handler.setInputAction((e) => {
    const lonlat = ctx.pickLonLat(e.position);
    if (!lonlat) return; // 如果没有点击到地面，返回

    // 移除预览点
    ctx._entities.remove(shape.tempEntity);
    shape.tempEntity = null;

    // 传了 id 且已存在：移除旧实体（含 shapes 数据），覆盖创建
    if (shape.id && ctx._entities.getById(shape.id)) {
      console.warn(`实体 id "${shape.id}" 已存在，旧实体将被移除`);
      const oldShape = ctx.shapes.find((s) => s.mainEntity.id === shape.id);
      if (oldShape) {
        ctx.removeShape(oldShape);
      } else {
        ctx._entities.removeById(shape.id);
      }
    }
    // 创建正式点实体
    shape.mainEntity = ctx.createPointEntity(lonlat, {
      size: shape.style.pointSize,
      color: shape.style.color,
      outline: false,
      id: shape.id,
    });
    shape.points = [lonlat];
    // 将正式点作为唯一可拖拽顶点（编辑模式可拖拽移动点的位置）
    shape.pointsEntity = [shape.mainEntity];
    ctx.emit("drawAddPoint", ctx._shapeResult(shape));
    if (ctx.activeShape !== shape) return;

    // 完成：入库、回调、根据配置进入编辑
    ctx.completeShape(shape);
  }, Cesium.ScreenSpaceEventType.LEFT_CLICK);
  ctx._emitDrawStart(shape);
}
