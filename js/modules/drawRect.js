/**
 * 画矩形模块（js/modules/drawRect.js）
 * 两个对角点确定矩形：左键点击第一点 → 鼠标移动实时预览 → 左键点击第二点完成。
 * 通过 ctx（Draw 实例）调用公共工具方法，与 drawLine / drawPoint 模块结构一致。
 *
 * 避坑说明（与既有模块一致）：
 * - 绘制前先 ctx.stopEditing() 清理遗留 handler，避免多实体互相干扰
 * - 预览实体 hierarchy 用自定义回调（基于临时鼠标点），不误用 points 数组
 * - 完成后 points 转为 4 个角点，polygon 与顶点均引用同一数组，编辑拖拽自动更新
 *
 * @param {object} ctx - Draw 实例（this）
 * @param {object} options - 画矩形参数
 * @param {string} [options.id] - 自定义实体 id（可选，不传则由 Cesium 自动生成）
 * @param {object} [options.style] - 样式（lineWidth / color / pointSize / clampToGround）
 * @param {Function} [options.success] - 绘制完成回调，返回 { id, positions, type }
 */
export default function drawRect(ctx, { id, style = {}, success }) {
  // 避坑：开始新绘制前，退出可能存在的编辑状态并销毁遗留 handler
  ctx.stopEditing();

  const shape = {
    type: "rect",
    id, // 用户自定义实体 id（可选）
    points: [], // 绘制中：对角点 [p1, p2]；完成后：4 个角点
    tempPoint: null, // 跟随鼠标的临时对角点（预览用）
    mainEntity: null, // 矩形实体（polygon）
    tempEntity: null, // 预览矩形实体（跟随鼠标）
    pointsEntity: [], // 4 个角点实体（编辑拖拽用）
    success, // 完成回调
    style: {
      lineWidth: style.lineWidth ?? ctx.config.lineWidth,
      color: style.color ?? ctx.config.color,
      pointSize: style.pointSize ?? ctx.config.pointSize,
      clampToGround: style.clampToGround ?? ctx.config.clampToGround,
    },
  };
  ctx.activeShape = shape;

  // 由两个对角点计算 4 个角（顺时针）
  const toCorners = (a, b) => [
    [a[0], a[1]],
    [b[0], a[1]],
    [b[0], b[1]],
    [a[0], b[1]],
  ];

  // 避坑：预览矩形 hierarchy 用自定义回调，根据当前对角点实时计算，不误用 points 数组
  shape.tempEntity = ctx.createPolygonEntity([], shape.style, {
    positions: () => {
      if (shape.points.length === 0) return [];
      return toCorners(shape.points[0], shape.tempPoint || shape.points[0]);
    },
  });
  shape.tempEntity.show = false;

  ctx.handler = new Cesium.ScreenSpaceEventHandler(ctx.viewer.scene.canvas);
  // 监听鼠标移动：更新预览矩形 + 显示坐标标签
  ctx.handler.setInputAction((e) => {
    const lonlat = ctx.pickLonLat(e.endPosition);
    if (!lonlat) {
      ctx.removeLabel();
      return;
    }
    ctx.addLabel(
      Cesium.Cartesian3.fromDegrees(lonlat[0], lonlat[1]),
      `左键点击确定对角点，右键撤销\n经度：${lonlat[0]}°\n纬度：${lonlat[1]}°`,
    );
    // 已有第一点时，跟随鼠标更新预览矩形
    if (shape.points.length > 0) {
      shape.tempPoint = lonlat;
      shape.tempEntity.show = true;
    }
  }, Cesium.ScreenSpaceEventType.MOUSE_MOVE);

  // 监听左键点击：第一点定起点，第二点定对角完成
  ctx.handler.setInputAction((e) => {
    const lonlat = ctx.pickLonLat(e.position);
    if (!lonlat) return; // 如果没有点击到地面，返回
    if (shape.points.length > 0) {
      const last = shape.points[shape.points.length - 1];
      if (last[0] === lonlat[0] && last[1] === lonlat[1]) return;
    }
    shape.points.push(lonlat);
    if (shape.points.length < 2) {
      // 第一点：显示预览矩形（跟随鼠标）
      shape.tempEntity.show = true;
      return;
    }
    // 第二点：完成绘制
    finishRect();
  }, Cesium.ScreenSpaceEventType.LEFT_CLICK);

  // 监听右键点击：撤销最后一个对角点，预览重绘
  ctx.handler.setInputAction((e) => {
    if (shape.points.length === 0) return; // 没有点可撤销
    shape.points.pop();
    if (shape.points.length === 0) {
      // 没有点了，预览矩形消失
      shape.tempEntity.show = false;
      shape.tempPoint = null;
    } else {
      // 回到第一点状态，预览矩形基于当前鼠标位置重绘
      const lonlat = ctx.pickLonLat(e.position);
      if (lonlat) {
        shape.tempPoint = lonlat;
        shape.tempEntity.show = true;
      }
    }
  }, Cesium.ScreenSpaceEventType.RIGHT_CLICK);

  // 完成绘制
  function finishRect() {
    if (shape.points.length < 2) return;
    // 移除预览矩形
    ctx.viewer.entities.remove(shape.tempEntity);
    shape.tempEntity = null;

    // 避坑：传了 id 且已存在时，先移除旧实体（含 shapes 数据），覆盖创建
    if (shape.id && ctx.viewer.entities.getById(shape.id)) {
      console.warn(`实体 id "${shape.id}" 已存在，旧实体将被移除`);
      const oldShape = ctx.shapes.find((s) => s.mainEntity.id === shape.id);
      if (oldShape) {
        ctx.removeShape(oldShape);
      } else {
        ctx.viewer.entities.removeById(shape.id);
      }
    }

    // 保持对角点数据（shape.points = [a, b] 两个对角点），创建正式矩形
    // 避坑：polygon hierarchy 用自定义回调，由对角点实时推导 4 角，编辑联动时自动更新
    shape.mainEntity = ctx.createPolygonEntity(shape.points, shape.style, {
      id: shape.id,
      positions: () => toCorners(shape.points[0], shape.points[1]),
    });
    // 4 个角点实体（画线样式：小号、无白边），编辑时可拖拽
    toCorners(shape.points[0], shape.points[1]).forEach((c) => {
      shape.pointsEntity.push(
        ctx.createPointEntity(c, {
          size: Math.max(shape.style.pointSize - 4, 4),
          color: shape.style.color,
          outline: false,
          clampToGround: shape.style.clampToGround,
        }),
      );
    });
    // 矩形专用联动：拖拽任意角，更新对应边界并保持矩形（对角点 a / b 联动）
    shape.updatePoint = (index, lonlat) => {
      const a = shape.points[0];
      const b = shape.points[1];
      switch (index) {
        case 0: // 左下角：更新 a
          a[0] = lonlat[0];
          a[1] = lonlat[1];
          break;
        case 1: // 右下角：更新 b 的经度 + a 的纬度
          b[0] = lonlat[0];
          a[1] = lonlat[1];
          break;
        case 2: // 右上角：更新 b
          b[0] = lonlat[0];
          b[1] = lonlat[1];
          break;
        case 3: // 左上角：更新 a 的经度 + b 的纬度
          a[0] = lonlat[0];
          b[1] = lonlat[1];
          break;
      }
      // 同步更新所有角点实体位置（保持矩形形状）
      toCorners(a, b).forEach((c, i) => {
        shape.pointsEntity[i].position.setValue(
          Cesium.Cartesian3.fromDegrees(c[0], c[1]),
        );
      });
    };

    // 完成：入库、回调、根据配置进入编辑
    ctx.completeShape(shape);
  }
  // 供 drawTool.stopDraw() 调用（预留，停止绘制直接清理，不触发完成）
  shape.finish = finishRect;
  ctx._emitDrawStart(shape);
}
